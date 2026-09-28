import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { requireFreshAdminTotp, requireOwner } from "../auth/guard";
import type { Env } from "../env";
import { getSwitchHistory, getSwitchStatus, rearmRound, saveRevision, setSwitchPaused } from "./repository";
import { scheduleInputSchema } from "./schema";

export { scheduleInputSchema } from "./schema";

export function registerSwitchRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.get("/api/switch", async (context) => {
    await requireOwner(context);
    return context.json(await getSwitchStatus(context.env.DB, new Date()));
  });
  app.put("/api/switch/schedule", async (context) => {
    const owner = await requireFreshAdminTotp(context);
    const parsed = scheduleInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "Invalid schedule", issues: parsed.error.issues }, 400);
    return context.json(await saveRevision(context.env.DB, owner.userId, parsed.data, new Date()), 201);
  });
  app.get("/api/switch/history", async (context) => {
    const owner = await requireOwner(context);
    return context.json(await getSwitchHistory(context.env.DB, owner.userId));
  });
  app.post("/api/switch/rounds/:id/rearm", async (context) => {
    await requireFreshAdminTotp(context);
    await rearmRound(context.env.DB, context.req.param("id"), new Date());
    return context.json({ ok: true });
  });
  app.put("/api/switch/paused", async (context) => {
    await requireFreshAdminTotp(context);
    const parsed = z.object({ paused: z.boolean() }).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "Invalid pause state" }, 400);
    await setSwitchPaused(context.env.DB, parsed.data.paused, new Date());
    return context.json({ paused: parsed.data.paused });
  });
}
