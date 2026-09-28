import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env } from "../env";
import { createAuth } from "./auth";

function reject(): never {
  throw new HTTPException(403, { message: "Setup claim denied" });
}

async function matchingSecret(expected: string, actual: string): Promise<boolean> {
  if (expected.length < 32) return false;
  const encoder = new TextEncoder();
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(actualHash);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function claimOwner(
  env: Env,
  input: { setupSecret: string; email: string; password: string },
): Promise<{ ownerId: string }> {
  const parsed = z.object({
    setupSecret: z.string(),
    email: z.email(),
    password: z.string().min(12),
  }).safeParse(input);
  if (!parsed.success) {
    throw new HTTPException(400, { message: "Valid email and a password of at least 12 characters required" });
  }
  if (!env.SETUP_SECRET || !parsed.data.setupSecret || !await matchingSecret(env.SETUP_SECRET, parsed.data.setupSecret)) reject();
  const email = parsed.data.email.trim().toLowerCase();
  const claimNonce = crypto.randomUUID();
  const now = new Date().toISOString();
  const reserved = await env.DB.prepare(
    "INSERT OR IGNORE INTO owner_slot (id, claim_nonce, claim_email, claim_started_at) VALUES (1, ?, ?, ?)",
  ).bind(claimNonce, email, now).run();
  const slot = await env.DB.prepare(
    "SELECT owner_id, claim_nonce, claim_email FROM owner_slot WHERE id = 1",
  ).first<{ owner_id: string | null; claim_nonce: string; claim_email: string }>();
  if (!slot || slot.owner_id || (reserved.meta.changes === 0 && slot.claim_email !== email)) reject();

  const existing = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  let ownerId = existing?.id;
  if (!ownerId) {
    const auth = createAuth(env, "http://localhost");
    const registered = await auth.api.signUpEmail({ body: { email, password: parsed.data.password, name: email } });
    ownerId = registered.user.id;
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE owner_slot SET owner_id = ?, claimed_at = ? WHERE id = 1 AND owner_id IS NULL AND claim_email = ?",
    ).bind(ownerId, now, email),
    env.DB.prepare(
      "INSERT INTO switches (id, owner_id, cycle_id, cycle_started_at, updated_at) SELECT 1, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM owner_slot WHERE id = 1 AND owner_id = ?)",
    ).bind(ownerId, crypto.randomUUID(), now, now, ownerId),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) reject();
  return { ownerId };
}
