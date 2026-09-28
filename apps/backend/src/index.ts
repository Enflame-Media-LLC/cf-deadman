import { createApp } from "./app";
import type { ActionJob } from "./domain/types";
import type { Env } from "./env";
import { tickSchedule } from "./execution/scheduler";
import { handleActionMessage } from "./execution/coordinator";
import { unconfiguredExecutor } from "./execution/executor";

const app = createApp();

async function onSchedule(env: Env): Promise<void> {
  await tickSchedule(env, new Date());
}

async function onQueue(batch: MessageBatch<ActionJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleActionMessage(env, message.body, unconfiguredExecutor, new Date());
      message.ack();
    } catch {
      console.error("action_message_failed", { messageId: message.id });
      message.retry();
    }
  }
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
