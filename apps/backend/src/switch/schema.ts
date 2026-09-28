import { z } from "zod";

export const delaySchema = z.object({
  amount: z.number().int().positive().max(10_000),
  unit: z.enum(["days", "weeks", "months"]),
});

export const scheduleInputSchema = z.object({
  rounds: z.array(z.object({
    id: z.string().min(1).max(100),
    delay: delaySchema,
    manualRearm: z.boolean(),
    groups: z.array(z.object({
      id: z.string().min(1).max(100),
      mode: z.enum(["ordered", "concurrent"]),
    })).min(1).max(50),
  })).min(1).max(50),
  reviewedDeadlines: z.array(z.object({
    roundId: z.string(),
    dueAt: z.iso.datetime({ offset: true }),
  })),
}).superRefine((value, context) => {
  const roundIds = value.rounds.map((round) => round.id);
  if (new Set(roundIds).size !== roundIds.length) {
    context.addIssue({ code: "custom", message: "Round IDs must be unique", path: ["rounds"] });
  }
  for (const round of value.rounds) {
    const groupIds = round.groups.map((group) => group.id);
    if (new Set(groupIds).size !== groupIds.length) {
      context.addIssue({ code: "custom", message: "Group IDs must be unique", path: ["rounds", round.id, "groups"] });
    }
  }
});

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
