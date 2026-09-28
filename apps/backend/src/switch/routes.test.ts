import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSwitchHistory, getSwitchStatus, rearmRound, saveRevision, setSwitchPaused } from "./repository";
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
  await env.DB.prepare("DELETE FROM outbox").run();
  await env.DB.prepare("DELETE FROM action_runs").run();
  await env.DB.prepare("DELETE FROM round_runs").run();
  await env.DB.prepare("DELETE FROM checkins").run();
  await env.DB.prepare("DELETE FROM actions").run();
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

  it("rejects an activation if check-in changes the reviewed cycle", async () => {
    const interleaved = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE switches SET cycle_id = 'cycle-2', cycle_started_at = '2028-02-01T00:00:00.000Z' WHERE id = 1").run();
        return env.DB.batch(statements);
      },
    } as D1Database;
    await expect(saveRevision(interleaved, "owner", roundInput(), start)).rejects.toMatchObject({ status: 409 });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM schedule_revisions").first<{ n: number }>())?.n).toBe(0);
  });

  it("preserves a manual round's disarmed state across revisions", async () => {
    const first = await saveRevision(env.DB, "owner", roundInput(), start);
    await env.DB.prepare("UPDATE round_arming SET armed = 0 WHERE round_id = ?").bind(first.rounds[0].id).run();
    const second = await saveRevision(env.DB, "owner", roundInput(), start);
    expect((await getSwitchStatus(env.DB, start)).rounds[0].armed).toBe(false);
    await rearmRound(env.DB, second.rounds[0].id, start);
    expect((await getSwitchStatus(env.DB, start)).rounds[0].armed).toBe(true);
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

  it("shows the next unfinished round and check-in history", async () => {
    const revision = await saveRevision(env.DB, "owner", roundInput(), start);
    await env.DB.prepare("INSERT INTO round_runs (id, cycle_id, revision_id, round_id, status, due_at, finished_at) VALUES ('done', 'cycle-1', ?, ?, 'succeeded', ?, ?)")
      .bind(revision.id, revision.rounds[0].id, "2028-02-29T00:00:00.000Z", "2028-02-29T00:00:01.000Z").run();
    await env.DB.prepare("INSERT INTO checkins (id, cycle_id, owner_id, method, session_id, accepted_at) VALUES ('check-1', 'cycle-1', 'owner', 'session', 'session-1', ?)")
      .bind(start.toISOString()).run();
    const group = await env.DB.prepare("SELECT id FROM action_groups WHERE round_id = ?").bind(revision.rounds[0].id).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO actions (id, group_id, ordinal, kind, config_ciphertext, failure_policy) VALUES ('action-1', ?, 0, 'webhook', '{}', 'continue')")
      .bind(group!.id).run();
    await env.DB.prepare("INSERT INTO action_runs (id, round_run_id, cycle_id, revision_id, action_id, status, reason) VALUES ('action-run-1', 'done', 'cycle-1', ?, 'action-1', 'needs_review', 'provider_unconfigured')")
      .bind(revision.id).run();
    expect((await getSwitchStatus(env.DB, start)).nextDueAt).toBe("2028-03-07T00:00:00.000Z");
    const history = await getSwitchHistory(env.DB, "owner");
    expect(history.checkIns).toMatchObject([{ method: "session", session_id: "session-1" }]);
    expect(history.runs).toMatchObject([{ status: "succeeded" }]);
    expect(history.actionRuns).toMatchObject([{ action_id: "action-1", kind: "webhook", reason: "provider_unconfigured" }]);
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
