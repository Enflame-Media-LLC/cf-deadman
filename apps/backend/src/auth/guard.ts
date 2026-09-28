import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import { createAuth } from "./auth";

export type OwnerSession = {
  userId: string;
  sessionId: string;
  adminTotpVerifiedAt: Date | null;
};

export async function requireOwner(context: Context<{ Bindings: Env }>): Promise<OwnerSession> {
  const auth = createAuth(context.env, context.req.url);
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  const slot = await context.env.DB.prepare("SELECT owner_id FROM owner_slot WHERE id = 1").first<{ owner_id: string | null }>();
  if (!session || !slot?.owner_id || session.user.id !== slot.owner_id) {
    throw new HTTPException(403, { message: "Owner session required" });
  }
  const proof = await context.env.DB.prepare(
    "SELECT verified_at FROM admin_totp_proofs WHERE session_id = ? AND owner_id = ?",
  ).bind(session.session.id, session.user.id).first<{ verified_at: string }>();
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    adminTotpVerifiedAt: proof ? new Date(proof.verified_at) : null,
  };
}

export async function requireFreshAdminTotp(context: Context<{ Bindings: Env }>): Promise<OwnerSession> {
  const owner = await requireOwner(context);
  if (!owner.adminTotpVerifiedAt || Date.now() - owner.adminTotpVerifiedAt.valueOf() > 5 * 60_000) {
    throw new HTTPException(403, { message: "Fresh administrator TOTP required" });
  }
  return owner;
}
