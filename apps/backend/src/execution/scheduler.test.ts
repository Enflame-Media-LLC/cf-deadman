import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionJob } from "../domain/types";
import type { Env } from "../env";
import { saveRevision } from "../switch/repository";
import { recordCheckIn } from "../checkin/routes";
import { claimAction, tickSchedule } from "./scheduler";

const start = "2028-01-01T00:00:00.000Z";
const due = new Date("2028-01-03T00:00:00Z");

function withQueue(send: (job: ActionJob) => Promise<void>): Env {
  return { ...env, ACTIONS: { send } as unknown as Queue<ActionJob> };
}

async function seed(roundCount = 1): Promise<{ revisionId: string; roundIds: string[]; actionIds: string[] }> {
  const rounds = Array.from({ length: roundCount }, (_, index) => ({
    id: `round-${index + 1}`,
    delay: { amount: 1, unit: "days" as const },
    manualRearm: false,
    groups: [{ id: `group-${index + 1}`, mode: "ordered" as const }],
  }));
  const revision = await saveRevision(env.DB, "owner", {
    rounds,
    reviewedDeadlines: rounds.map((round, index) => ({ roundId: round.id, dueAt: `2028-01-0${index + 2}T00:00:00.000Z` })),
  }, new Date(start));
  const actionIds: string[] = [];
  for (const [index, round] of revision.rounds.entries()) {
    const group = await env.DB.prepare("SELECT id FROM action_groups WHERE round_id = ?")
      .bind(round.id).first<{ id: string }>();
    const actionId = `action-${index + 1}`;
    actionIds.push(actionId);
    await env.DB.prepare("INSERT INTO actions (id, group_id, ordinal, kind, config_ciphertext, failure_policy) VALUES (?, ?, 0, 'webhook', 'encrypted', 'continue')")
      .bind(actionId, group!.id).run();
  }
  await env.DB.prepare("UPDATE switches SET armed = 1 WHERE id = 1").run();
  return { revisionId: revision.id, roundIds: revision.rounds.map((round) => round.id), actionIds };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["outbox", "action_runs", "round_runs", "actions", "action_groups", "round_arming", "schedule_rounds", "schedule_revisions", "checkins", "switches", "owner_slot"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO owner_slot (id, owner_id, claim_nonce, claim_email, claim_started_at, claimed_at) VALUES (1, 'owner', 'claim', 'owner@example.com', ?, ?)")
    .bind(start, start).run();
  await env.DB.prepare("INSERT INTO switches (id, owner_id, cycle_id, cycle_started_at, updated_at) VALUES (1, 'owner', 'cycle-1', ?, ?)")
    .bind(start, start).run();
});

describe("schedule tick and action claims", () => {
  it("claims one due round", async () => {
    await seed();
    const sent = vi.fn(async (_job: ActionJob) => {});
    await tickSchedule(withQueue(sent), due);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM round_runs").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'published'").first<{ n: number }>())?.n).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("waits for prior round", async () => {
    await seed(2);
    const workerEnv = withQueue(async () => {});
    await tickSchedule(workerEnv, due);
    await tickSchedule(workerEnv, due);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM round_runs").first<{ n: number }>())?.n).toBe(1);
    await env.DB.prepare("UPDATE round_runs SET status = 'succeeded' WHERE cycle_id = 'cycle-1'").run();
    await tickSchedule(workerEnv, due);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM round_runs").first<{ n: number }>())?.n).toBe(2);
  });

  it("recovers lost publish", async () => {
    await seed();
    const send = vi.fn().mockRejectedValueOnce(new Error("queue unavailable")).mockResolvedValue(undefined);
    await tickSchedule(withQueue(send), due);
    expect((await env.DB.prepare("SELECT status FROM outbox").first<{ status: string }>())?.status).toBe("pending");
    await tickSchedule(withQueue(send), due);
    expect((await env.DB.prepare("SELECT status FROM outbox").first<{ status: string }>())?.status).toBe("published");
  });

  it("retries after D1 failure", async () => {
    const { revisionId, roundIds } = await seed();
    await env.DB.prepare("INSERT INTO round_runs (id, cycle_id, revision_id, round_id, status, due_at) VALUES (?, 'cycle-1', ?, ?, 'running', ?)")
      .bind(`cycle-1:${roundIds[0]}`, revisionId, roundIds[0], "2028-01-02T00:00:00.000Z").run();
    await tickSchedule(withQueue(async () => {}), due);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM action_runs").first<{ n: number }>())?.n).toBe(1);
  });

  it("claims duplicate once", async () => {
    const { revisionId, actionIds } = await seed();
    await tickSchedule(withQueue(async () => {}), due);
    const actionRun = await env.DB.prepare("SELECT id FROM action_runs").first<{ id: string }>();
    const job = { runId: actionRun!.id, cycleId: "cycle-1", revisionId, actionId: actionIds[0] };
    expect(await claimAction(env.DB, job, due)).toBe("claimed");
    expect(await claimAction(env.DB, job, due)).toBe("duplicate");
  });

  it("skips old cycle", async () => {
    const { revisionId, actionIds } = await seed();
    await tickSchedule(withQueue(async () => {}), due);
    const actionRun = await env.DB.prepare("SELECT id FROM action_runs").first<{ id: string }>();
    const job = { runId: actionRun!.id, cycleId: "cycle-1", revisionId, actionId: actionIds[0] };
    await recordCheckIn(env.DB, { method: "session", sessionId: "owner-session" }, new Date("2028-01-03T00:00:01Z"));
    expect(await claimAction(env.DB, job, due)).toBe("stale");
  });
});
