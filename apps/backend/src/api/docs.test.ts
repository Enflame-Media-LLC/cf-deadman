import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("API documentation", () => {
  it("documents every application route", async () => {
    const response = await SELF.fetch("http://localhost/api/openapi.json");
    expect(response.status).toBe(200);
    const document = await response.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toMatch(/^3\.1\./);
    for (const path of [
      "/api/health", "/api/setup", "/api/setup/status", "/api/switch", "/api/switch/schedule",
      "/api/switch/history", "/api/switch/rounds/{id}/rearm", "/api/switch/paused",
      "/api/check-ins", "/api/check-in-policy", "/api/check-in-keys", "/api/check-in-keys/{id}",
    ]) expect(document.paths).toHaveProperty(path);
  });

  it("exposes Better Auth's OpenAPI schema", async () => {
    const response = await SELF.fetch("http://localhost/api/auth/open-api/generate-schema");
    expect(response.status).toBe(200);
    const document = await response.json() as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  it("links both schemas from documentation", async () => {
    const response = await SELF.fetch("http://localhost/api/docs");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("/api/openapi.json");
    expect(html).toContain("/api/auth/open-api/generate-schema");
  });
});
