import { createApp } from "./app";
import type { ActionJob } from "./domain/types";
import type { Env } from "./env";
import { tickSchedule } from "./execution/scheduler";

const app = createApp();

async function onSchedule(env: Env): Promise<void> {
  await tickSchedule(env, new Date());
}

async function onQueue(_batch: MessageBatch<ActionJob>, _env: Env): Promise<void> {
  // The action coordinator is installed in Task 7.
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    return app.fetch(request, env, context);
  },
  scheduled(_controller: ScheduledController, env: Env) {
    return onSchedule(env);
  },
  queue(batch: MessageBatch<ActionJob>, env: Env) {
    return onQueue(batch, env);
  },
} satisfies ExportedHandler<Env, ActionJob>;
