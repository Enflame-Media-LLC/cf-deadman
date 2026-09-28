import type { ActionJob } from "../domain/types";
import { computeDeadlines } from "../domain/deadlines";
import type { Env } from "../env";
import { dispatchOutbox, enqueueAction } from "./outbox";

type ActiveSwitch = {
  cycle_id: string;
  cycle_started_at: string;
  active_revision_id: string | null;
  armed: number;
  paused: number;
};

type RoundRow = {
  id: string;
  delay_amount: number;
  delay_unit: "days" | "weeks" | "months";
  manual_rearm: number;
  armed: number;
};

type ActionRow = {
  id: string;
  group_ordinal: number;
  action_ordinal: number;
  mode: "ordered" | "concurrent";
};

async function ensureActionRuns(
  db: D1Database,
  cycleId: string,
  revisionId: string,
  roundId: string,
  now: Date,
): Promise<void> {
  const roundRunId = `${cycleId}:${roundId}`;
  const { results: actions } = await db.prepare(
    "SELECT a.id, g.ordinal AS group_ordinal, a.ordinal AS action_ordinal, g.mode FROM actions a JOIN action_groups g ON g.id = a.group_id WHERE g.round_id = ? ORDER BY g.ordinal, a.ordinal",
  ).bind(roundId).all<ActionRow>();
  if (!actions.length) {
    await db.prepare("UPDATE round_runs SET status = 'succeeded', finished_at = ? WHERE id = ? AND status = 'running'")
      .bind(now.toISOString(), roundRunId).run();
    return;
  }
  await db.batch(actions.map((action) => db.prepare(
    "INSERT OR IGNORE INTO action_runs (id, round_run_id, cycle_id, revision_id, action_id, status) SELECT ?, ?, ?, ?, ?, 'pending' WHERE EXISTS (SELECT 1 FROM switches WHERE id = 1 AND cycle_id = ?) AND EXISTS (SELECT 1 FROM round_runs WHERE id = ? AND status = 'running')",
  ).bind(`${cycleId}:${action.id}`, roundRunId, cycleId, revisionId, action.id, cycleId, roundRunId)));
  const firstGroup = actions[0].group_ordinal;
  for (const action of actions) {
    if (action.group_ordinal !== firstGroup) break;
    if (action.mode === "ordered" && action.action_ordinal !== actions[0].action_ordinal) break;
    const job: ActionJob = {
      runId: `${cycleId}:${action.id}`, cycleId, revisionId, actionId: action.id,
    };
    await enqueueAction(db, job, now);
  }
}

export async function tickSchedule(env: Env, now: Date): Promise<void> {
  const active = await env.DB.prepare(
    "SELECT cycle_id, cycle_started_at, active_revision_id, armed, paused FROM switches WHERE id = 1",
  ).first<ActiveSwitch>();
  if (active?.armed && !active.paused && active.active_revision_id) {
    const { results: rounds } = await env.DB.prepare(
      "SELECT r.id, r.delay_amount, r.delay_unit, r.manual_rearm, a.armed FROM schedule_rounds r JOIN round_arming a ON a.round_id = r.id WHERE r.revision_id = ? ORDER BY r.ordinal",
    ).bind(active.active_revision_id).all<RoundRow>();
    const deadlines = computeDeadlines(new Date(active.cycle_started_at), rounds.map((round) => ({
      id: round.id, delay: { amount: round.delay_amount, unit: round.delay_unit },
    })));
    for (const [index, round] of rounds.entries()) {
      if (deadlines[index].dueAt > now) break;
      const runId = `${active.cycle_id}:${round.id}`;
      let run = await env.DB.prepare("SELECT status FROM round_runs WHERE id = ?")
        .bind(runId).first<{ status: string }>();
      if (!run) {
        if (round.manual_rearm && !round.armed) {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO round_runs (id, cycle_id, revision_id, round_id, status, due_at, finished_at) VALUES (?, ?, ?, ?, 'skipped', ?, ?)",
          ).bind(runId, active.cycle_id, active.active_revision_id, round.id, deadlines[index].dueAt.toISOString(), now.toISOString()).run();
          continue;
        }
        await env.DB.batch([
          env.DB.prepare(
            "INSERT OR IGNORE INTO round_runs (id, cycle_id, revision_id, round_id, status, due_at, started_at) SELECT ?, ?, ?, ?, 'running', ?, ? WHERE EXISTS (SELECT 1 FROM switches WHERE id = 1 AND cycle_id = ? AND armed = 1 AND paused = 0)",
          ).bind(runId, active.cycle_id, active.active_revision_id, round.id, deadlines[index].dueAt.toISOString(), now.toISOString(), active.cycle_id),
          env.DB.prepare("UPDATE round_arming SET armed = 0, updated_at = ? WHERE round_id = ? AND ? = 1 AND EXISTS (SELECT 1 FROM switches WHERE id = 1 AND cycle_id = ? AND armed = 1 AND paused = 0)")
            .bind(now.toISOString(), round.id, round.manual_rearm, active.cycle_id),
        ]);
        run = await env.DB.prepare("SELECT status FROM round_runs WHERE id = ?")
          .bind(runId).first<{ status: string }>();
      }
      if (run?.status === "running") {
        await ensureActionRuns(env.DB, active.cycle_id, active.active_revision_id, round.id, now);
        break;
      }
      if (!run || run.status === "pending") break;
    }
  }
  await dispatchOutbox(env);
}

export async function claimAction(
  db: D1Database,
  job: ActionJob,
  now: Date,
): Promise<"claimed" | "stale" | "duplicate"> {
  const result = await db.prepare(
    "UPDATE action_runs SET status = 'claimed', claimed_at = ? WHERE id = ? AND cycle_id = ? AND revision_id = ? AND action_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM switches WHERE id = 1 AND cycle_id = ?) AND EXISTS (SELECT 1 FROM outbox WHERE action_run_id = ?) AND EXISTS (SELECT 1 FROM round_runs WHERE id = action_runs.round_run_id AND status = 'running')",
  ).bind(now.toISOString(), job.runId, job.cycleId, job.revisionId, job.actionId, job.cycleId, job.runId).run();
  if (result.meta.changes === 1) return "claimed";
  const active = await db.prepare("SELECT cycle_id FROM switches WHERE id = 1").first<{ cycle_id: string }>();
  const run = await db.prepare("SELECT status, cycle_id FROM action_runs WHERE id = ?")
    .bind(job.runId).first<{ status: string; cycle_id: string }>();
  if (!run || !active || run.cycle_id !== active.cycle_id || job.cycleId !== active.cycle_id) return "stale";
  return "duplicate";
}
