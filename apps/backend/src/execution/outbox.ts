import type { ActionJob } from "../domain/types";
import type { Env } from "../env";

export async function dispatchOutbox(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, payload_json FROM outbox WHERE status = 'pending' ORDER BY created_at LIMIT 100",
  ).all<{ id: string; payload_json: string }>();
  for (const row of results) {
    const job = JSON.parse(row.payload_json) as ActionJob;
    try {
      await env.ACTIONS.send(job);
      await env.DB.prepare("UPDATE outbox SET status = 'published', published_at = ? WHERE id = ? AND status = 'pending'")
        .bind(new Date().toISOString(), row.id).run();
    } catch {
      console.error("action_outbox_publish_failed", {
        outboxId: row.id, runId: job.runId,
      });
    }
  }
}

export async function enqueueAction(db: D1Database, job: ActionJob, now: Date): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO outbox (id, action_run_id, payload_json, status, created_at) SELECT ?, ?, ?, 'pending', ? WHERE EXISTS (SELECT 1 FROM switches WHERE id = 1 AND cycle_id = ?) AND EXISTS (SELECT 1 FROM action_runs WHERE id = ? AND cycle_id = ? AND status = 'pending')",
  ).bind(job.runId, job.runId, JSON.stringify(job), now.toISOString(), job.cycleId, job.runId, job.cycleId).run();
  await db.prepare(
    "UPDATE outbox SET status = 'pending', published_at = NULL WHERE action_run_id = ? AND status = 'published' AND EXISTS (SELECT 1 FROM switches WHERE id = 1 AND cycle_id = ? AND armed = 1 AND paused = 0) AND EXISTS (SELECT 1 FROM action_runs WHERE id = ? AND cycle_id = ? AND status = 'pending')",
  ).bind(job.runId, job.cycleId, job.runId, job.cycleId).run();
}
