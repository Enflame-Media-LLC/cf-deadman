import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import Dashboard from "./Dashboard.vue";

const status = {
  ownerId: "owner", activeRevisionId: "revision", cycleId: "cycle", cycleStartedAt: "2028-01-01T00:00:00.000Z",
  armed: false, paused: false, nextDueAt: "2028-01-02T00:00:00.000Z", rounds: [],
};

describe("dashboard", () => {
  it("shows the exact local deadline", async () => {
    const html = await renderToString(createSSRApp(Dashboard, { status, timeZone: "America/Chicago" }));
    expect(html).toContain("Jan 1, 2028");
    expect(html).toContain("6:00 PM");
  });

  it("does not offer arming", async () => {
    const html = await renderToString(createSSRApp(Dashboard, { status, timeZone: "UTC" }));
    expect(html).not.toContain("Arm switch");
    expect(html).toContain("Check in");
  });
});
