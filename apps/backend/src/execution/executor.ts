import type { ActionDefinition } from "../domain/types";

export interface ActionExecutor {
  execute(action: ActionDefinition, runId: string): Promise<"succeeded" | "failed" | "needs_review">;
}

/** Foundation deployments have no configured outbound provider. */
export const unconfiguredExecutor: ActionExecutor = {
  async execute() {
    return "needs_review";
  },
};
