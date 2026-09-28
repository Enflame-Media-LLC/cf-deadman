import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker foundation", () => {
  it("serves health and migrates foundation", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const response = await SELF.fetch("http://localhost/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });

    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all<{ name: string }>();
    const tables = results.map((row) => row.name);
    expect(tables).toContain("owner_slot");
    expect(tables).toContain("schedule_revisions");
    expect(tables).toContain("action_runs");
    expect(tables).toContain("outbox");
  });
});
