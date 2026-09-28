import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createAuth } from "../auth/auth";
import type { Env } from "../env";

export const checkInMethodSchema = z.enum(["session", "session_totp", "api_key", "api_key_totp"]);
export type CheckInMethod = z.infer<typeof checkInMethodSchema>;
export const checkInPolicySchema = z.object({
  methods: z.array(checkInMethodSchema).min(1),
  regenerateTotp: z.boolean().optional(),
}).superRefine(({ methods }, context) => {
  if (new Set(methods).size !== methods.length) {
    context.addIssue({ code: "custom", message: "Duplicate check-in method" });
  }
});

export type CheckInProof = { method: CheckInMethod; keyId?: string; sessionId?: string };

export async function getCheckInPolicy(db: D1Database): Promise<{ methods: CheckInMethod[]; hasSeparateTotp: boolean }> {
  const row = await db.prepare("SELECT methods_json, totp_secret_ciphertext FROM checkin_policy WHERE id = 1")
    .first<{ methods_json: string; totp_secret_ciphertext: string | null }>();
  return {
    methods: row ? JSON.parse(row.methods_json) as CheckInMethod[] : ["session"],
    hasSeparateTotp: Boolean(row?.totp_secret_ciphertext),
  };
}

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function decodeBase32(secret: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid TOTP secret");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}

export function createCheckInTotpSecret(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)));
}

async function aesKey(passphrase: string): Promise<CryptoKey> {
  if (passphrase.length < 32) throw new Error("DATA_ENCRYPTION_KEY must be at least 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passphrase));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(passphrase: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(passphrase), new TextEncoder().encode(secret)));
  return btoa(String.fromCharCode(...iv, ...cipher));
}

export async function decryptSecret(passphrase: string, ciphertext: string): Promise<string> {
  const raw = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(passphrase), raw.slice(12));
  return new TextDecoder().decode(plain);
}

export async function verifyTotp(secret: string, code: string, at: Date): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const key = await crypto.subtle.importKey("raw", new Uint8Array(Array.from(decodeBase32(secret))), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const window = Math.floor(at.valueOf() / 30_000);
  let match = 0;
  for (const offset of [-1, 0, 1]) {
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(window + offset));
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
    const position = digest[digest.length - 1] & 15;
    const value = (((digest[position] & 127) << 24) | (digest[position + 1] << 16) |
      (digest[position + 2] << 8) | digest[position + 3]) % 1_000_000;
    match |= Number(value.toString().padStart(6, "0") === code);
  }
  return match === 1;
}

async function identityHash(request: Request): Promise<string> {
  const source = request.headers.get("cf-connecting-ip") ?? request.headers.get("authorization") ?? "anonymous";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit(db: D1Database, identity: string, now: Date): Promise<void> {
  const row = await db.prepare("SELECT window_started_at, attempts FROM checkin_attempts WHERE identity_hash = ?")
    .bind(identity).first<{ window_started_at: string; attempts: number }>();
  if (row && now.valueOf() - new Date(row.window_started_at).valueOf() < 300_000 && row.attempts >= 5) {
    throw new HTTPException(429, { message: "Check-in proof rate limit exceeded" });
  }
}

async function recordFailure(db: D1Database, identity: string, now: Date): Promise<never> {
  const nowIso = now.toISOString();
  await db.prepare(
    "INSERT INTO checkin_attempts (identity_hash, window_started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(identity_hash) DO UPDATE SET attempts = CASE WHEN julianday(?) - julianday(window_started_at) > (5.0 / 1440.0) THEN 1 ELSE attempts + 1 END, window_started_at = CASE WHEN julianday(?) - julianday(window_started_at) > (5.0 / 1440.0) THEN ? ELSE window_started_at END",
  ).bind(identity, nowIso, nowIso, nowIso, nowIso).run();
  throw new HTTPException(403, { message: "Invalid check-in proof" });
}

export async function verifyCheckInProof(env: Env, request: Request): Promise<CheckInProof> {
  const now = new Date();
  const identity = await identityHash(request);
  await checkRateLimit(env.DB, identity, now);
  const policy = await getCheckInPolicy(env.DB);
  const totpCode = request.headers.get("x-checkin-totp");
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  const method: CheckInMethod = bearer ? (totpCode ? "api_key_totp" : "api_key") :
    (totpCode ? "session_totp" : "session");
  if (!policy.methods.includes(method)) return recordFailure(env.DB, identity, now);

  let keyId: string | undefined;
  let sessionId: string | undefined;
  if (bearer) {
    const auth = createAuth(env, request.url);
    const result = await auth.api.verifyApiKey({ body: { key: bearer, permissions: { "check-in": ["create"] } } })
      .catch(() => null);
    if (!result?.valid || !result.key) return recordFailure(env.DB, identity, now);
    keyId = result.key.id;
    const local = await env.DB.prepare(
      "SELECT owner_id, expires_at, revoked_at FROM checkin_keys WHERE id = ?",
    ).bind(keyId).first<{ owner_id: string; expires_at: string | null; revoked_at: string | null }>();
    const owner = await env.DB.prepare("SELECT owner_id FROM owner_slot WHERE id = 1")
      .first<{ owner_id: string | null }>();
    if (!local || local.revoked_at || (local.expires_at && new Date(local.expires_at) <= now) ||
        local.owner_id !== owner?.owner_id) return recordFailure(env.DB, identity, now);
  } else {
    const auth = createAuth(env, request.url);
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    const owner = await env.DB.prepare("SELECT owner_id FROM owner_slot WHERE id = 1")
      .first<{ owner_id: string | null }>();
    if (!session || session.user.id !== owner?.owner_id) return recordFailure(env.DB, identity, now);
    sessionId = session.session.id;
  }

  if (totpCode) {
    const row = await env.DB.prepare("SELECT totp_secret_ciphertext FROM checkin_policy WHERE id = 1")
      .first<{ totp_secret_ciphertext: string | null }>();
    if (!row?.totp_secret_ciphertext ||
        !await verifyTotp(await decryptSecret(env.DATA_ENCRYPTION_KEY, row.totp_secret_ciphertext), totpCode, now)) {
      return recordFailure(env.DB, identity, now);
    }
  }
  return { method, keyId, sessionId };
}
