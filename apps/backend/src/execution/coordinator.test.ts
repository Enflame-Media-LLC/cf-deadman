import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionJob, FailurePolicy, GroupMode } from "../domain/types";
import type { Env } from "../env";
import { saveRevision } from "../switch/repository";
import { handleActionMessage } from "./coordinator";
import type { ActionExecutor } from "./executor";
import { claimAction, tickSchedule } from "./scheduler";
import { recordCheckIn } from "../checkin/routes";

const start = "2028-01-01T00:00:00.000Z";
const due = new Date("2028-01-02T00:00:00Z");
type GroupSpec = { mode: GroupMode; actions: { id: string; policy?: FailurePolicy }[] };

async function scenario(groups: GroupSpec[]) {
  const jobs: ActionJob[] = [];
  const workerEnv = { ...env, ACTIONS: { send: async (job: ActionJob) => { jobs.push(job); } } as unknown as Queue<ActionJob> } satisfies Env;
  const revision = await saveRevision(env.DB, "owner", {
    rounds: [{ id: "round", delay: { amount: 1, unit: "days" }, manualRearm: false,
      groups: groups.map((group, index) => ({ id: `group-${index}`, mode: group.mode })) }],
    reviewedDeadlines: [{ roundId: "round", dueAt: "2028-01-02T00:00:00.000Z" }],
  }, new Date(start));
  const { results: groupRows } = await env.DB.prepare("SELECT id FROM action_groups WHERE round_id = ? ORDER BY ordinal")
    .bind(revision.rounds[0].id).all<{ id: string }>();
  for (const [groupIndex, group] of groups.entries()) {
    for (const [actionIndex, action] of group.actions.entries()) {
      await env.DB.prepare("INSERT INTO actions (id, group_id, ordinal, kind, config_ciphertext, failure_policy) VALUES (?, ?, ?, 'webhook', '{}', ?)")
        .bind(action.id, groupRows[groupIndex].id, actionIndex, action.policy ?? "continue").run();
    }
  }
  await env.DB.prepare("UPDATE switches SET armed = 1 WHERE id = 1").run();
  await tickSchedule(workerEnv, due);
  return { workerEnv, jobs, revision };
}

async function statuses(): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT action_id, status FROM action_runs").all<{ action_id: string; status: string }>();
  return Object.fromEntries(results.map((row) => [row.action_id, row.status]));
}

async function roundStatus(): Promise<string | null> {
  return (await env.DB.prepare("SELECT status FROM round_runs").first<{ status: string }>())?.status ?? null;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["outbox", "action_runs", "round_runs", "actions", "action_groups", "round_arming", "schedule_rounds", "schedule_revisions", "switches", "owner_slot"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO owner_slot (id, owner_id, claim_nonce, claim_email, claim_started_at, claimed_at) VALUES (1, 'owner', 'claim', 'owner@example.com', ?, ?)")
    .bind(start, start).run();
  await env.DB.prepare("INSERT INTO switches (id, owner_id, cycle_id, cycle_started_at, updated_at) VALUES (1, 'owner', 'cycle-1', ?, ?)")
    .bind(start, start).run();
});

describe("action coordinator", () => {
  it("orders actions", async () => {
    const { workerEnv, jobs } = await scenario([{ mode: "ordered", actions: [{ id: "a" }, { id: "b" }] }]);
    expect(jobs.map((job) => job.actionId)).toEqual(["a"]);
    const calls: string[] = [];
    const executor: ActionExecutor = { execute: async (action) => { calls.push(action.id); return "succeeded"; } };
    await handleActionMessage(workerEnv, jobs[0], executor, due);
    expect(jobs.map((job) => job.actionId)).toEqual(["a", "b"]);
    await handleActionMessage(workerEnv, jobs[1], executor, due);
    expect(calls).toEqual(["a", "b"]);
    expect(await roundStatus()).toBe("succeeded");
  });

  it("starts concurrent siblings", async () => {
    const { workerEnv, jobs } = await scenario([{ mode: "concurrent", actions: [{ id: "a" }, { id: "b" }] }]);
    expect(jobs.map((job) => job.actionId)).toEqual(["a", "b"]);
    const execute = vi.fn(async () => "succeeded" as const);
    await Promise.all(jobs.map((job) => handleActionMessage(workerEnv, job, { execute }, due)));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await roundStatus()).toBe("succeeded");
  });

  it("waits for started siblings", async () => {
    const { workerEnv, jobs } = await scenario([
      { mode: "concurrent", actions: [{ id: "a" }, { id: "b" }] },
      { mode: "ordered", actions: [{ id: "c" }] },
    ]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const executor: ActionExecutor = { execute: async (action) => {
      if (action.id === "a") { started(); await gate; }
      return "succeeded";
    } };
    const held = handleActionMessage(workerEnv, jobs[0], executor, due);
    await entered;
    await handleActionMessage(workerEnv, jobs[1], executor, due);
    expect(jobs.map((job) => job.actionId)).toEqual(["a", "b"]);
    release();
    await held;
    expect(jobs.map((job) => job.actionId)).toEqual(["a", "b", "c"]);
  });

  it("continues after failure", async () => {
    const { workerEnv, jobs } = await scenario([{ mode: "ordered", actions: [{ id: "a", policy: "continue" }, { id: "b" }] }]);
    const executor: ActionExecutor = { execute: async (action) => action.id === "a" ? "failed" : "succeeded" };
    await handleActionMessage(workerEnv, jobs[0], executor, due);
    await handleActionMessage(workerEnv, jobs[1], executor, due);
    expect(await statuses()).toEqual({ a: "failed", b: "succeeded" });
    expect(await roundStatus()).toBe("failed");
  });

  it("stops group", async () => {
    const { workerEnv, jobs } = await scenario([
      { mode: "ordered", actions: [{ id: "a", policy: "stop_group" }, { id: "b" }] },
      { mode: "ordered", actions: [{ id: "c" }] },
    ]);
    const executor: ActionExecutor = { execute: async (action) => action.id === "a" ? "failed" : "succeeded" };
    await handleActionMessage(workerEnv, jobs[0], executor, due);
    expect(jobs.map((job) => job.actionId)).toEqual(["a", "c"]);
    await handleActionMessage(workerEnv, jobs[1], executor, due);
    expect(await statuses()).toEqual({ a: "failed", b: "skipped", c: "succeeded" });
  });

  it("stops round", async () => {
    const { workerEnv, jobs } = await scenario([
      { mode: "concurrent", actions: [{ id: "a" }, { id: "b", policy: "stop_round" }, { id: "c" }] },
      { mode: "ordered", actions: [{ id: "d" }] },
    ]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const calls: string[] = [];
    const executor: ActionExecutor = { execute: async (action) => {
      calls.push(action.id);
      if (action.id === "a") { started(); await gate; }
      return action.id === "b" ? "failed" : "succeeded";
    } };
    const held = handleActionMessage(workerEnv, jobs[0], executor, due);
    await entered;
    await handleActionMessage(workerEnv, jobs[1], executor, due);
    expect(await statuses()).toEqual({ a: "claimed", b: "failed", c: "skipped", d: "skipped" });
    expect(await roundStatus()).toBe("running");
    await handleActionMessage(workerEnv, jobs[2], executor, due);
    expect(calls).toEqual(["a", "b"]);
    release();
    await held;
    expect(await statuses()).toEqual({ a: "succeeded", b: "failed", c: "skipped", d: "skipped" });
    expect(await roundStatus()).toBe("failed");
  });

  it("blocks a sibling claim as soon as a stop-round failure is durable", async () => {
    const { jobs } = await scenario([{ mode: "concurrent", actions: [
      { id: "a", policy: "stop_round" }, { id: "b" },
    ] }]);
    await env.DB.prepare("UPDATE action_runs SET status = 'failed' WHERE id = ?").bind(jobs[0].runId).run();
    expect(await claimAction(env.DB, jobs[1], due)).not.toBe("claimed");
    expect((await statuses()).b).toBe("pending");
  });

  it("ignores duplicate delivery", async () => {
    const { workerEnv, jobs } = await scenario([{ mode: "ordered", actions: [{ id: "a" }] }]);
    const execute = vi.fn(async () => "succeeded" as const);
    await handleActionMessage(workerEnv, jobs[0], { execute }, due);
    await handleActionMessage(workerEnv, jobs[0], { execute }, due);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reconciles a saved result after interrupted progression", async () => {
    const { workerEnv, jobs } = await scenario([{ mode: "ordered", actions: [{ id: "a" }, { id: "b" }] }]);
    await env.DB.prepare("UPDATE action_runs SET status = 'succeeded', finished_at = ? WHERE id = ?")
      .bind(due.toISOString(), jobs[0].runId).run();
    await handleActionMessage(workerEnv, jobs[0], { execute: vi.fn() }, due);
    expect(jobs.map((job) => job.actionId)).toEqual(["a", "b"]);
  });

  it("quarantines an abandoned claim without repeating its effect", async () => {
    const { workerEnv, jobs } = await scenario([{ mode: "ordered", actions: [{ id: "a" }, { id: "b" }] }]);
    await env.DB.prepare("UPDATE action_runs SET status = 'claimed', claimed_at = ? WHERE id = ?")
      .bind("2028-01-01T00:00:00.000Z", jobs[0].runId).run();
    await tickSchedule(workerEnv, due);
    expect(await statuses()).toEqual({ a: "needs_review", b: "skipped" });
    expect(await roundStatus()).toBe("needs_review");
  });

  it("does not execute an old-cycle delivery after check-in", async () => {
    const { workerEnv, jobs } = await scenario([{ mode: "ordered", actions: [{ id: "a" }] }]);
    await recordCheckIn(env.DB, { method: "session", sessionId: "owner-session" }, new Date("2028-01-02T00:00:01Z"));
    const execute = vi.fn(async () => "succeeded" as const);
    await handleActionMessage(workerEnv, jobs[0], { execute }, due);
    expect(execute).not.toHaveBeenCalled();
    expect((await statuses()).a).toBe("canceled");
  });
});
