import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import Policy from "./Policy.vue";

describe("check-in policy", () => {
  it("explains all enabled paths", async () => {
    const html = await renderToString(createSSRApp(Policy, {
      policy: { methods: ["session", "session_totp", "api_key", "api_key_totp"], hasSeparateTotp: true },
    }));
    expect(html).toContain("Owner session");
    expect(html).toContain("Session and check-in code");
    expect(html).toContain("API key");
    expect(html).toContain("API key and check-in code");
  });
});
