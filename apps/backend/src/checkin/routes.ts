import type { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createAuth } from "../auth/auth";
import { requireFreshAdminTotp, requireOwner } from "../auth/guard";
import type { Env } from "../env";
import { getSwitchStatus } from "../switch/repository";
import {
  checkInPolicySchema, createCheckInTotpSecret, encryptSecret, getCheckInPolicy,
  verifyCheckInProof, type CheckInProof,
} from "./policy";

export async function recordCheckIn(
  db: D1Database,
  proof: CheckInProof,
  at: Date,
): Promise<{ cycleId: string; nextDueAt: string | null }> {
  const previous = await db.prepare("SELECT owner_id, cycle_id FROM switches WHERE id = 1")
    .first<{ owner_id: string; cycle_id: string }>();
  if (!previous) throw new HTTPException(404, { message: "Switch is not set up" });
  const nextCycleId = crypto.randomUUID();
  const acceptedAt = at.toISOString();
  const results = await db.batch([
    db.prepare("UPDATE switches SET cycle_id = ?, cycle_started_at = ?, updated_at = ? WHERE id = 1 AND cycle_id = ?")
      .bind(nextCycleId, acceptedAt, acceptedAt, previous.cycle_id),
    db.prepare("INSERT INTO checkins (id, cycle_id, owner_id, method, key_id, session_id, accepted_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM switches WHERE id = 1 AND cycle_id = ?)")
      .bind(crypto.randomUUID(), nextCycleId, previous.owner_id, proof.method, proof.keyId ?? null, proof.sessionId ?? null, acceptedAt, nextCycleId),
    db.prepare("UPDATE outbox SET status = 'canceled' WHERE status = 'pending' AND action_run_id IN (SELECT id FROM action_runs WHERE cycle_id = ?)")
      .bind(previous.cycle_id),
    db.prepare("UPDATE action_runs SET status = 'canceled', reason = 'check_in', finished_at = ? WHERE cycle_id = ? AND status = 'pending'")
      .bind(acceptedAt, previous.cycle_id),
    db.prepare("UPDATE round_runs SET status = 'canceled', finished_at = ? WHERE cycle_id = ? AND status IN ('pending', 'running') AND NOT EXISTS (SELECT 1 FROM action_runs WHERE round_run_id = round_runs.id AND status = 'claimed')")
      .bind(acceptedAt, previous.cycle_id),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new HTTPException(409, { message: "Cycle changed during check-in" });
  }
  const status = await getSwitchStatus(db, at);
  return { cycleId: nextCycleId, nextDueAt: status.nextDueAt };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function registerCheckInRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.post("/api/check-ins", async (context) => {
    const proof = await verifyCheckInProof(context.env, context.req.raw);
    return context.json(await recordCheckIn(context.env.DB, proof, new Date()), 201);
  });

  app.get("/api/check-in-policy", async (context) => {
    await requireOwner(context);
    return context.json(await getCheckInPolicy(context.env.DB));
  });

  app.put("/api/check-in-policy", async (context) => {
    await requireFreshAdminTotp(context);
    const parsed = checkInPolicySchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "At least one valid check-in path is required" }, 400);
    const previous = await context.env.DB.prepare("SELECT totp_secret_ciphertext FROM checkin_policy WHERE id = 1")
      .first<{ totp_secret_ciphertext: string | null }>();
    const needsTotp = parsed.data.methods.some((method) => method.endsWith("_totp"));
    let ciphertext = previous?.totp_secret_ciphertext ?? null;
    let setupUri: string | undefined;
    if (needsTotp && (!ciphertext || parsed.data.regenerateTotp)) {
      const secret = createCheckInTotpSecret();
      ciphertext = await encryptSecret(context.env.DATA_ENCRYPTION_KEY, secret);
      setupUri = `otpauth://totp/CF%20Deadman:check-in?secret=${secret}&issuer=CF%20Deadman&algorithm=SHA1&digits=6&period=30`;
    }
    const now = new Date().toISOString();
    await context.env.DB.prepare(
      "INSERT INTO checkin_policy (id, methods_json, totp_secret_ciphertext, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET methods_json = excluded.methods_json, totp_secret_ciphertext = excluded.totp_secret_ciphertext, updated_at = excluded.updated_at",
    ).bind(JSON.stringify(parsed.data.methods), ciphertext, now).run();
    return context.json({ methods: parsed.data.methods, hasSeparateTotp: Boolean(ciphertext), ...(setupUri ? { setupUri } : {}) });
  });

  app.get("/api/check-in-keys", async (context) => {
    const owner = await requireOwner(context);
    const { results } = await context.env.DB.prepare(
      "SELECT id, created_at, expires_at, revoked_at FROM checkin_keys WHERE owner_id = ? ORDER BY created_at DESC",
    ).bind(owner.userId).all();
    return context.json({ keys: results });
  });

  app.post("/api/check-in-keys", async (context) => {
    const owner = await requireFreshAdminTotp(context);
    const parsed = z.object({ name: z.string().min(1).max(100), expiresInSeconds: z.number().int().positive().max(31_536_000).optional() })
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "Invalid key request" }, 400);
    const auth = createAuth(context.env, context.req.url);
    const created = await auth.api.createApiKey({ body: {
      userId: owner.userId,
      name: parsed.data.name,
      expiresIn: parsed.data.expiresInSeconds,
      permissions: { "check-in": ["create"] },
      rateLimitEnabled: true,
      rateLimitTimeWindow: 60_000,
      rateLimitMax: 60,
    } });
    await context.env.DB.prepare(
      "INSERT INTO checkin_keys (id, owner_id, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(created.id, owner.userId, await sha256Hex(created.key), new Date().toISOString(),
      parsed.data.expiresInSeconds ? new Date(Date.now() + parsed.data.expiresInSeconds * 1000).toISOString() : null).run();
    return context.json({ id: created.id, key: created.key }, 201);
  });

  app.delete("/api/check-in-keys/:id", async (context) => {
    const owner = await requireFreshAdminTotp(context);
    const keyId = context.req.param("id");
    const now = new Date().toISOString();
    const results = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE checkin_keys SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL")
        .bind(now, keyId, owner.userId),
      context.env.DB.prepare("UPDATE apikey SET enabled = 0 WHERE id = ? AND referenceId = ?")
        .bind(keyId, owner.userId),
    ]);
    if (results[0].meta.changes !== 1) throw new HTTPException(404, { message: "Key not found" });
    return context.json({ revoked: true });
  });
}
