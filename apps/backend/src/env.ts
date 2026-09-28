import type { ActionJob } from "./domain/types";

export type Env = {
  DB: D1Database;
  ACTIONS: Queue<ActionJob>;
  SETUP_SECRET: string;
  BETTER_AUTH_SECRET: string;
  DATA_ENCRYPTION_KEY: string;
  ASSETS: Fetcher;
};
