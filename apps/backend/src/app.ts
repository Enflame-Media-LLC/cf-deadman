import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "./env";
import { createAuth } from "./auth/auth";
import { claimOwner } from "./auth/setup";
import { registerSwitchRoutes } from "./switch/routes";
import { registerCheckInRoutes } from "./checkin/routes";
import { registerDocsRoutes } from "./api/docs";

export function createApp(): OpenAPIHono<{ Bindings: Env }> {
  const app = new OpenAPIHono<{ Bindings: Env }>();
  app.get("/api/health", (context) => context.json({ status: "ok" }));
  registerSwitchRoutes(app);
  registerCheckInRoutes(app);
  registerDocsRoutes(app);
  app.get("/api/setup/status", async (context) => {
    const row = await context.env.DB.prepare("SELECT owner_id FROM owner_slot WHERE id = 1")
      .first<{ owner_id: string | null }>();
    return context.json({ claimed: Boolean(row?.owner_id) });
  });
  app.post("/api/setup", async (context) => {
    const body = await context.req.json<{ setupSecret: string; email: string; password: string }>();
    const result = await claimOwner(context.env, body);
    return context.json(result, 201);
  });
  app.on(["GET", "POST"], ["/api/auth/*"], async (context) => {
    const path = new URL(context.req.url).pathname;
    if (path.startsWith("/api/auth/sign-up/") ||
        path.startsWith("/api/auth/api-key/") ||
        path === "/api/auth/delete-user" ||
        path === "/api/auth/two-factor/disable") {
      return context.json({ error: "Endpoint is restricted" }, 403);
    }
    if (path.startsWith("/api/auth/two-factor/verify-") && context.req.method === "POST") {
      const body = await context.req.raw.clone().json().catch(() => null) as { trustDevice?: boolean } | null;
      if (body?.trustDevice === true) {
        return context.json({ error: "Trusted devices are disabled" }, 400);
      }
    }
    const auth = createAuth(context.env, context.req.url);
    const response = await auth.handler(context.req.raw);
    if (path === "/api/auth/two-factor/verify-totp" && response.ok) {
      const cookiePairs = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]);
      const requestCookie = context.req.header("cookie");
      if (requestCookie) cookiePairs.push(requestCookie);
      const headers = new Headers({ cookie: cookiePairs.join("; ") });
      const session = await auth.api.getSession({ headers });
      if (session) {
        const owner = await context.env.DB.prepare("SELECT owner_id FROM owner_slot WHERE id = 1").first<{ owner_id: string | null }>();
        if (owner?.owner_id === session.user.id) {
          await context.env.DB.prepare(
            "INSERT INTO admin_totp_proofs (session_id, owner_id, verified_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET verified_at = excluded.verified_at",
          ).bind(session.session.id, session.user.id, new Date().toISOString()).run();
        }
      }
    }
    return response;
  });
  return app;
}
