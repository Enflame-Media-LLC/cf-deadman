export type ActionJob = {
  runId: string;
  cycleId: string;
  revisionId: string;
  actionId: string;
};

export type Delay = { amount: number; unit: "days" | "weeks" | "months" };
export type GroupMode = "ordered" | "concurrent";
export type FailurePolicy = "continue" | "stop_group" | "stop_round";
export type ActionDefinition = {
  id: string;
  kind: "email" | "webhook" | "sms" | "browser";
  config: unknown;
  failurePolicy: FailurePolicy;
};
