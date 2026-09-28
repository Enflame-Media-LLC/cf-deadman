import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "./env";

export function createApp(): OpenAPIHono<{ Bindings: Env }> {
  const app = new OpenAPIHono<{ Bindings: Env }>();
  app.get("/api/health", (context) => context.json({ status: "ok" }));
  return app;
}
