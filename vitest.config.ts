import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./apps/backend/migrations") } },
  })],
  test: { include: ["apps/backend/src/**/*.test.ts", "apps/web/src/**/*.test.ts"] },
}));
