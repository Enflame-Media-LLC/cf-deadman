import { HTTPException } from "hono/http-exception";
import { computeDeadlines } from "../domain/deadlines";
import { scheduleInputSchema, type ScheduleInput } from "./schema";

export type ScheduleRevision = {
  id: string;
  version: number;
  deadlines: { roundId: string; dueAt: string }[];
  rounds: { id: string; clientId: string; manualRearm: boolean }[];
};

export type SwitchStatus = {
  ownerId: string;
  activeRevisionId: string | null;
  cycleId: string;
  cycleStartedAt: string;
  armed: boolean;
  paused: boolean;
  nextDueAt: string | null;
  rounds: { id: string; dueAt: string; manualRearm: boolean; armed: boolean }[];
};

export type SwitchHistory = {
  revisions: { id: string; version: number; definition_json: string; created_at: string }[];
  runs: { id: string; cycle_id: string; revision_id: string; round_id: string; status: string; due_at: string; started_at: string | null; finished_at: string | null }[];
  actionRuns: { id: string; round_run_id: string; action_id: string; kind: string; status: string; reason: string | null; claimed_at: string | null; finished_at: string | null }[];
  checkIns: { id: string; cycle_id: string; method: string; key_id: string | null; session_id: string | null; accepted_at: string }[];
};

type SwitchRow = {
  owner_id: string;
  active_revision_id: string | null;
  cycle_id: string;
  cycle_started_at: string;
  armed: number;
  paused: number;
};

async function switchRow(db: D1Database): Promise<SwitchRow> {
  const row = await db.prepare("SELECT owner_id, active_revision_id, cycle_id, cycle_started_at, armed, paused FROM switches WHERE id = 1")
    .first<SwitchRow>();
  if (!row) throw new HTTPException(404, { message: "Switch is not set up" });
  return row;
}

export async function saveRevision(
  db: D1Database,
  ownerId: string,
  input: ScheduleInput,
  now: Date,
): Promise<ScheduleRevision> {
  const parsed = scheduleInputSchema.safeParse(input);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid schedule" });
  const active = await switchRow(db);
  if (active.owner_id !== ownerId) throw new HTTPException(403, { message: "Owner required" });
  const computed = computeDeadlines(new Date(active.cycle_started_at), parsed.data.rounds)
    .map(({ roundId, dueAt }) => ({ roundId, dueAt: dueAt.toISOString() }));
  if (JSON.stringify(computed) !== JSON.stringify(parsed.data.reviewedDeadlines)) {
    throw new HTTPException(409, { message: "Reviewed deadlines do not match the current cycle" });
  }
  const current = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schedule_revisions WHERE owner_id = ?")
    .bind(ownerId).first<{ version: number }>();
  const revisionId = crypto.randomUUID();
  const version = (current?.version ?? 0) + 1;
  const createdAt = now.toISOString();
  const priorArming = new Map<string, boolean>();
  if (active.active_revision_id) {
    const prior = await db.prepare("SELECT definition_json FROM schedule_revisions WHERE id = ?")
      .bind(active.active_revision_id).first<{ definition_json: string }>();
    const { results: states } = await db.prepare(
      "SELECT r.ordinal, a.armed FROM schedule_rounds r JOIN round_arming a ON a.round_id = r.id WHERE r.revision_id = ? ORDER BY r.ordinal",
    ).bind(active.active_revision_id).all<{ ordinal: number; armed: number }>();
    const definitions = JSON.parse(prior?.definition_json ?? "[]") as ScheduleInput["rounds"];
    for (const state of states) {
      const definition = definitions[state.ordinal];
      if (definition?.manualRearm) priorArming.set(definition.id, Boolean(state.armed));
    }
  }
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE switches SET active_revision_id = ?, updated_at = ? WHERE id = 1 AND owner_id = ? AND cycle_id = ? AND active_revision_id IS ?")
      .bind(revisionId, createdAt, ownerId, active.cycle_id, active.active_revision_id),
    db.prepare("INSERT INTO schedule_revisions (id, owner_id, version, definition_json, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM switches WHERE id = 1 AND active_revision_id = ?)")
      .bind(revisionId, ownerId, version, JSON.stringify(parsed.data.rounds), createdAt, revisionId),
  ];
  const rounds: ScheduleRevision["rounds"] = [];
  for (const [roundOrdinal, round] of parsed.data.rounds.entries()) {
    const roundId = crypto.randomUUID();
    rounds.push({ id: roundId, clientId: round.id, manualRearm: round.manualRearm });
    statements.push(db.prepare(
      "INSERT INTO schedule_rounds (id, revision_id, ordinal, delay_amount, delay_unit, manual_rearm) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(roundId, revisionId, roundOrdinal, round.delay.amount, round.delay.unit, Number(round.manualRearm)));
    statements.push(db.prepare("INSERT INTO round_arming (round_id, armed, updated_at) VALUES (?, ?, ?)")
      .bind(roundId, Number(priorArming.get(round.id) ?? true), createdAt));
    for (const [groupOrdinal, group] of round.groups.entries()) {
      statements.push(db.prepare(
        "INSERT INTO action_groups (id, round_id, ordinal, mode) VALUES (?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), roundId, groupOrdinal, group.mode));
    }
  }
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const latest = await switchRow(db);
    if (latest.cycle_id !== active.cycle_id || latest.active_revision_id !== active.active_revision_id) {
      throw new HTTPException(409, { message: "Cycle or revision changed during schedule save" });
    }
    throw error;
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new HTTPException(409, { message: "Cycle changed during schedule save" });
  }
  return { id: revisionId, version, deadlines: computed, rounds };
}

export async function getSwitchStatus(db: D1Database, _now: Date): Promise<SwitchStatus> {
  const active = await switchRow(db);
  const rounds: SwitchStatus["rounds"] = [];
  const completed = new Set<string>();
  if (active.active_revision_id) {
    const { results: finished } = await db.prepare(
      "SELECT round_id FROM round_runs WHERE cycle_id = ? AND status IN ('succeeded', 'failed', 'skipped', 'canceled', 'needs_review')",
    ).bind(active.cycle_id).all<{ round_id: string }>();
    for (const run of finished) completed.add(run.round_id);
    const { results } = await db.prepare(
      "SELECT r.id, r.delay_amount, r.delay_unit, r.manual_rearm, a.armed FROM schedule_rounds r JOIN round_arming a ON a.round_id = r.id WHERE r.revision_id = ? ORDER BY r.ordinal",
    ).bind(active.active_revision_id).all<{
      id: string; delay_amount: number; delay_unit: "days" | "weeks" | "months"; manual_rearm: number; armed: number;
    }>();
    const deadlines = computeDeadlines(new Date(active.cycle_started_at), results.map((round) => ({
      id: round.id, delay: { amount: round.delay_amount, unit: round.delay_unit },
    })));
    for (const [index, round] of results.entries()) {
      rounds.push({
        id: round.id,
        dueAt: deadlines[index].dueAt.toISOString(),
        manualRearm: Boolean(round.manual_rearm),
        armed: Boolean(round.armed),
      });
    }
  }
  return {
    ownerId: active.owner_id,
    activeRevisionId: active.active_revision_id,
    cycleId: active.cycle_id,
    cycleStartedAt: active.cycle_started_at,
    armed: Boolean(active.armed),
    paused: Boolean(active.paused),
    nextDueAt: rounds.find((round) => round.armed && !completed.has(round.id))?.dueAt ?? null,
    rounds,
  };
}

export async function getSwitchHistory(db: D1Database, ownerId: string): Promise<SwitchHistory> {
  const [revisions, runs, actionRuns, checkIns] = await Promise.all([
    db.prepare("SELECT id, version, definition_json, created_at FROM schedule_revisions WHERE owner_id = ? ORDER BY version DESC LIMIT 200")
      .bind(ownerId).all<SwitchHistory["revisions"][number]>(),
    db.prepare("SELECT rr.id, rr.cycle_id, rr.revision_id, rr.round_id, rr.status, rr.due_at, rr.started_at, rr.finished_at FROM round_runs rr JOIN schedule_revisions sr ON sr.id = rr.revision_id WHERE sr.owner_id = ? ORDER BY rr.due_at DESC LIMIT 200")
      .bind(ownerId).all<SwitchHistory["runs"][number]>(),
    db.prepare("SELECT ar.id, ar.round_run_id, ar.action_id, a.kind, ar.status, ar.reason, ar.claimed_at, ar.finished_at FROM action_runs ar JOIN actions a ON a.id = ar.action_id JOIN round_runs rr ON rr.id = ar.round_run_id JOIN schedule_revisions sr ON sr.id = rr.revision_id WHERE sr.owner_id = ? ORDER BY COALESCE(ar.finished_at, ar.claimed_at, rr.due_at) DESC LIMIT 500")
      .bind(ownerId).all<SwitchHistory["actionRuns"][number]>(),
    db.prepare("SELECT id, cycle_id, method, key_id, session_id, accepted_at FROM checkins WHERE owner_id = ? ORDER BY accepted_at DESC LIMIT 200")
      .bind(ownerId).all<SwitchHistory["checkIns"][number]>(),
  ]);
  return { revisions: revisions.results, runs: runs.results, actionRuns: actionRuns.results, checkIns: checkIns.results };
}

export async function rearmRound(db: D1Database, roundId: string, now: Date): Promise<void> {
  const result = await db.prepare(
    "UPDATE round_arming SET armed = 1, updated_at = ? WHERE round_id = ? AND round_id IN (SELECT r.id FROM schedule_rounds r JOIN switches s ON s.active_revision_id = r.revision_id WHERE s.id = 1 AND r.manual_rearm = 1)",
  ).bind(now.toISOString(), roundId).run();
  if (result.meta.changes !== 1) throw new HTTPException(404, { message: "Manual-rearm round not found" });
}

export async function setSwitchPaused(db: D1Database, paused: boolean, now: Date): Promise<void> {
  const result = await db.prepare("UPDATE switches SET paused = ?, updated_at = ? WHERE id = 1")
    .bind(Number(paused), now.toISOString()).run();
  if (result.meta.changes !== 1) throw new HTTPException(404, { message: "Switch is not set up" });
}
