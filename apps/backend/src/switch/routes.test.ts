import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSwitchStatus, rearmRound, saveRevision, setSwitchPaused } from "./repository";
import { scheduleInputSchema } from "./routes";

const start = new Date("2028-01-31T00:00:00Z");
const roundInput = (reviewedDueAt = "2028-02-29T00:00:00.000Z") => ({
  rounds: [
    { id: "notice", delay: { amount: 1, unit: "months" as const }, manualRearm: true, groups: [{ id: "notice-group", mode: "ordered" as const }] },
    { id: "release", delay: { amount: 1, unit: "weeks" as const }, manualRearm: false, groups: [{ id: "release-group", mode: "concurrent" as const }] },
  ],
  reviewedDeadlines: [
    { roundId: "notice", dueAt: reviewedDueAt },
    { roundId: "release", dueAt: "2028-03-07T00:00:00.000Z" },
  ],
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM action_groups").run();
  await env.DB.prepare("DELETE FROM round_arming").run();
  await env.DB.prepare("DELETE FROM schedule_rounds").run();
  await env.DB.prepare("DELETE FROM schedule_revisions").run();
  await env.DB.prepare("DELETE FROM switches").run();
  await env.DB.prepare("DELETE FROM owner_slot").run();
  await env.DB.prepare("INSERT INTO owner_slot (id, owner_id, claim_nonce, claim_email, claim_started_at, claimed_at) VALUES (1, 'owner', 'claim', 'owner@example.com', ?, ?)")
    .bind(start.toISOString(), start.toISOString()).run();
  await env.DB.prepare("INSERT INTO switches (id, owner_id, cycle_id, cycle_started_at, updated_at) VALUES (1, 'owner', 'cycle-1', ?, ?)")
    .bind(start.toISOString(), start.toISOString()).run();
});

describe("schedule revisions", () => {
  it("rejects empty schedule", () => {
    expect(scheduleInputSchema.safeParse({ rounds: [], reviewedDeadlines: [] }).success).toBe(false);
  });

  it("previews exact deadlines", async () => {
    await expect(saveRevision(env.DB, "owner", roundInput("2028-02-28T00:00:00.000Z"), start)).rejects.toThrow();
    const revision = await saveRevision(env.DB, "owner", roundInput(), start);
    expect(revision.deadlines.map((item) => item.dueAt)).toEqual([
      "2028-02-29T00:00:00.000Z", "2028-03-07T00:00:00.000Z",
    ]);
  });

  it("creates immutable revision", async () => {
    const first = await saveRevision(env.DB, "owner", roundInput(), start);
    const second = await saveRevision(env.DB, "owner", roundInput(), start);
    expect(second.id).not.toBe(first.id);
    const prior = await env.DB.prepare("SELECT definition_json FROM schedule_revisions WHERE id = ?")
      .bind(first.id).first<{ definition_json: string }>();
    expect(prior).not.toBeNull();
    const status = await getSwitchStatus(env.DB, start);
    expect(status.activeRevisionId).toBe(second.id);
  });

  it("keeps manual rearm disarmed", async () => {
    const revision = await saveRevision(env.DB, "owner", roundInput(), start);
    await env.DB.prepare("UPDATE round_arming SET armed = 0 WHERE round_id = ?").bind(revision.rounds[0].id).run();
    await env.DB.prepare("UPDATE switches SET cycle_id = 'cycle-2', cycle_started_at = ? WHERE id = 1")
      .bind("2028-04-30T00:00:00.000Z").run();
    const status = await getSwitchStatus(env.DB, new Date("2028-05-01T00:00:00Z"));
    expect(status.rounds[0].armed).toBe(false);
    expect(status.rounds[1].dueAt).toBe("2028-06-06T00:00:00.000Z");
    await rearmRound(env.DB, revision.rounds[0].id, new Date());
    expect((await getSwitchStatus(env.DB, new Date())).rounds[0].armed).toBe(true);
  });

  it("pause blocks claims", async () => {
    await setSwitchPaused(env.DB, true, start);
    expect((await getSwitchStatus(env.DB, start)).paused).toBe(true);
  });

  it("denies unauthenticated status", async () => {
    const response = await SELF.fetch("http://localhost/api/switch");
    expect(response.status).toBe(403);
  });
});
