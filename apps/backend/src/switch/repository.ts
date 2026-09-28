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
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO schedule_revisions (id, owner_id, version, definition_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(revisionId, ownerId, version, JSON.stringify(parsed.data.rounds), createdAt),
  ];
  const rounds: ScheduleRevision["rounds"] = [];
  for (const [roundOrdinal, round] of parsed.data.rounds.entries()) {
    const roundId = crypto.randomUUID();
    rounds.push({ id: roundId, clientId: round.id, manualRearm: round.manualRearm });
    statements.push(db.prepare(
      "INSERT INTO schedule_rounds (id, revision_id, ordinal, delay_amount, delay_unit, manual_rearm) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(roundId, revisionId, roundOrdinal, round.delay.amount, round.delay.unit, Number(round.manualRearm)));
    statements.push(db.prepare("INSERT INTO round_arming (round_id, armed, updated_at) VALUES (?, 1, ?)")
      .bind(roundId, createdAt));
    for (const [groupOrdinal, group] of round.groups.entries()) {
      statements.push(db.prepare(
        "INSERT INTO action_groups (id, round_id, ordinal, mode) VALUES (?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), roundId, groupOrdinal, group.mode));
    }
  }
  statements.push(db.prepare("UPDATE switches SET active_revision_id = ?, updated_at = ? WHERE id = 1 AND owner_id = ?")
    .bind(revisionId, createdAt, ownerId));
  await db.batch(statements);
  return { id: revisionId, version, deadlines: computed, rounds };
}

export async function getSwitchStatus(db: D1Database, _now: Date): Promise<SwitchStatus> {
  const active = await switchRow(db);
  const rounds: SwitchStatus["rounds"] = [];
  if (active.active_revision_id) {
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
    nextDueAt: rounds.find((round) => round.armed)?.dueAt ?? null,
    rounds,
  };
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
