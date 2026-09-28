import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env } from "../env";
import { createAuth } from "./auth";

function reject(): never {
  throw new HTTPException(403, { message: "Setup claim denied" });
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
  if (!env.SETUP_SECRET || !parsed.data.setupSecret || parsed.data.setupSecret !== env.SETUP_SECRET) reject();
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
  const result = await env.DB.prepare(
    "UPDATE owner_slot SET owner_id = ?, claimed_at = ? WHERE id = 1 AND owner_id IS NULL AND claim_email = ?",
  ).bind(ownerId, now, email).run();
  if (result.meta.changes !== 1) reject();
  await env.DB.prepare(
    "INSERT INTO switches (id, owner_id, cycle_id, cycle_started_at, updated_at) VALUES (1, ?, ?, ?, ?)",
  ).bind(ownerId, crypto.randomUUID(), now, now).run();
  return { ownerId };
}
