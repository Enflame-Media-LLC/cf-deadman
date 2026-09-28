import type { Delay } from "./types";

function addDelay(from: Date, delay: Delay): Date {
  if (!Number.isSafeInteger(delay.amount) || delay.amount <= 0) {
    throw new RangeError("Delay must be a positive integer");
  }
  if (delay.unit === "days" || delay.unit === "weeks") {
    const result = new Date(from);
    result.setUTCDate(result.getUTCDate() + delay.amount * (delay.unit === "weeks" ? 7 : 1));
    return result;
  }
  if (delay.unit !== "months") {
    throw new RangeError("Unsupported delay unit");
  }
  const firstOfMonth = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth() + delay.amount,
    1,
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds(),
  ));
  const endOfMonth = new Date(Date.UTC(
    firstOfMonth.getUTCFullYear(),
    firstOfMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  firstOfMonth.setUTCDate(Math.min(from.getUTCDate(), endOfMonth));
  return firstOfMonth;
}

export function computeDeadlines(
  startAt: Date,
  rounds: readonly { id: string; delay: Delay }[],
): readonly { roundId: string; dueAt: Date }[] {
  if (Number.isNaN(startAt.valueOf())) throw new RangeError("Invalid start date");
  const deadlines: { roundId: string; dueAt: Date }[] = [];
  let previous = new Date(startAt);
  for (const round of rounds) {
    previous = addDelay(previous, round.delay);
    deadlines.push({ roundId: round.id, dueAt: new Date(previous) });
  }
  return deadlines;
}
