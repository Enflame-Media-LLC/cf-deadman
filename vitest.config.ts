import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations("./apps/backend/migrations"),
      SETUP_SECRET: "test-setup-secret",
      BETTER_AUTH_SECRET: "test-auth-secret-at-least-thirty-two-characters",
      DATA_ENCRYPTION_KEY: "test-encryption-key-at-least-thirty-two-characters",
    } },
  })],
  test: { include: ["apps/backend/src/**/*.test.ts", "apps/web/src/**/*.test.ts"], testTimeout: 20_000 },
}));
