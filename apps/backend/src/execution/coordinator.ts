import type { ActionJob, FailurePolicy, GroupMode } from "../domain/types";
import type { Env } from "../env";
import { dispatchOutbox, enqueueAction } from "./outbox";
import { claimAction } from "./scheduler";
import type { ActionExecutor } from "./executor";

type ActionRow = {
  run_id: string;
  action_id: string;
  status: string;
  group_id: string;
  group_ordinal: number;
  action_ordinal: number;
  mode: GroupMode;
  kind: "email" | "webhook" | "sms" | "browser";
  config_ciphertext: string;
  failure_policy: FailurePolicy;
  round_run_id: string;
};

async function actionRow(db: D1Database, runId: string): Promise<ActionRow | null> {
  return db.prepare(
    "SELECT ar.id AS run_id, ar.action_id, ar.status, ar.round_run_id, g.id AS group_id, g.ordinal AS group_ordinal, a.ordinal AS action_ordinal, g.mode, a.kind, a.config_ciphertext, a.failure_policy FROM action_runs ar JOIN actions a ON a.id = ar.action_id JOIN action_groups g ON g.id = a.group_id WHERE ar.id = ?",
  ).bind(runId).first<ActionRow>();
}

async function progressRound(db: D1Database, job: ActionJob, roundRunId: string, now: Date): Promise<void> {
  const { results } = await db.prepare(
    "SELECT ar.id AS run_id, ar.action_id, ar.status, g.ordinal AS group_ordinal, a.ordinal AS action_ordinal, g.mode FROM action_runs ar JOIN actions a ON a.id = ar.action_id JOIN action_groups g ON g.id = a.group_id WHERE ar.round_run_id = ? ORDER BY g.ordinal, a.ordinal",
  ).bind(roundRunId).all<Pick<ActionRow, "run_id" | "action_id" | "status" | "group_ordinal" | "action_ordinal" | "mode">>();
  if (!results.length) return;
  const next = results.find((row) => row.status === "pending" || row.status === "claimed");
  if (next) {
    const group = results.filter((row) => row.group_ordinal === next.group_ordinal);
    if (group.some((row) => row.status === "claimed")) return;
    const pending = group.filter((row) => row.status === "pending");
    for (const row of (next.mode === "ordered" ? pending.slice(0, 1) : pending)) {
      await enqueueAction(db, {
        runId: row.run_id, cycleId: job.cycleId, revisionId: job.revisionId, actionId: row.action_id,
      }, now);
    }
    return;
  }
  const finalStatus = results.some((row) => row.status === "needs_review") ? "needs_review" :
    results.some((row) => row.status === "failed") ? "failed" :
      results.some((row) => row.status === "canceled") ? "canceled" : "succeeded";
  await db.prepare("UPDATE round_runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .bind(finalStatus, now.toISOString(), roundRunId).run();
}

function stopStatements(db: D1Database, roundRunId: string, now: Date): D1PreparedStatement[] {
  const skipped = `SELECT pending.id FROM action_runs pending WHERE pending.round_run_id = ? AND pending.status = 'pending' AND EXISTS (
    SELECT 1 FROM action_runs failed JOIN actions source ON source.id = failed.action_id
    WHERE failed.round_run_id = pending.round_run_id AND
      (failed.status = 'needs_review' OR (failed.status = 'failed' AND
        (source.failure_policy = 'stop_round' OR (source.failure_policy = 'stop_group' AND source.group_id = (SELECT target.group_id FROM actions target WHERE target.id = pending.action_id)))))
  )`;
  return [
    db.prepare(`UPDATE action_runs SET status = 'skipped', reason = 'failure_policy', finished_at = ? WHERE id IN (${skipped})`)
      .bind(now.toISOString(), roundRunId),
    db.prepare("UPDATE outbox SET status = 'canceled' WHERE status = 'pending' AND action_run_id IN (SELECT id FROM action_runs WHERE round_run_id = ? AND status = 'skipped')")
      .bind(roundRunId),
  ];
}

async function reconcileRound(db: D1Database, roundRunId: string, now: Date): Promise<void> {
  const run = await db.prepare("SELECT cycle_id, revision_id, status FROM round_runs WHERE id = ?")
    .bind(roundRunId).first<{ cycle_id: string; revision_id: string; status: string }>();
  if (run?.status !== "running") return;
  await db.batch(stopStatements(db, roundRunId, now));
  await progressRound(db, { runId: "", actionId: "", cycleId: run.cycle_id, revisionId: run.revision_id }, roundRunId, now);
}

export async function reconcileRunningRounds(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const { results: runs } = await db.prepare("SELECT id FROM round_runs WHERE status = 'running'").all<{ id: string }>();
  for (const run of runs) {
    await db.prepare(
      "UPDATE action_runs SET status = 'needs_review', reason = 'claim_timeout', finished_at = ? WHERE round_run_id = ? AND status = 'claimed' AND claimed_at < ?",
    ).bind(now.toISOString(), run.id, cutoff).run();
    await reconcileRound(db, run.id, now);
  }
}

export async function handleActionMessage(
  env: Env,
  job: ActionJob,
  executor: ActionExecutor,
  now: Date,
): Promise<void> {
  if (await claimAction(env.DB, job, now) !== "claimed") {
    const existing = await actionRow(env.DB, job.runId);
    if (existing && ["succeeded", "failed", "needs_review", "skipped", "canceled"].includes(existing.status)) {
      await reconcileRound(env.DB, existing.round_run_id, now);
      await dispatchOutbox(env);
    }
    return;
  }
  const row = await actionRow(env.DB, job.runId);
  if (!row) throw new Error(`Claimed action run missing: ${job.runId}`);
  let result: "succeeded" | "failed" | "needs_review";
  try {
    result = await executor.execute({
      id: row.action_id,
      kind: row.kind,
      config: row.config_ciphertext,
      failurePolicy: row.failure_policy,
    }, row.run_id);
  } catch {
    result = "failed";
  }
  const finishedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE action_runs SET status = ?, reason = ?, finished_at = ? WHERE id = ? AND status = 'claimed'")
      .bind(result, result === "succeeded" ? null : result, finishedAt, row.run_id),
    ...stopStatements(env.DB, row.round_run_id, now),
  ]);
  await reconcileRound(env.DB, row.round_run_id, now);
  await dispatchOutbox(env);
}
