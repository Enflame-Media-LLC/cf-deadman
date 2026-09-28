import type { D1Migration } from "@cloudflare/vitest-plugin";
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      SETUP_SECRET: string;
      BETTER_AUTH_SECRET: string;
      DATA_ENCRYPTION_KEY: string;
    }
  }
}

export {};
