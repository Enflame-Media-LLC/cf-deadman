import { describe, expect, it, vi } from "vitest";
import { createSwitchClient } from "./api";

const status = (nextDueAt: string) => ({
  ownerId: "owner", activeRevisionId: "revision", cycleId: "cycle", cycleStartedAt: "2028-01-01T00:00:00.000Z",
  armed: false, paused: false, nextDueAt, rounds: [],
});

describe("web API client", () => {
  it("claims and signs in", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ ownerId: "owner" }), { status: 201, headers: { "content-type": "application/json" } });
    });
    const client = createSwitchClient(fetcher);
    await client.claimOwner({ setupSecret: "secret", email: "owner@example.com", password: "correct horse battery staple" });
    await client.signIn("owner@example.com", "correct horse battery staple");
    expect(requests).toEqual(["/api/setup", "/api/auth/sign-in/email"]);
  });

  it("reports check-in outcome and replaces the due date", async () => {
    let loadCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/switch") {
        loadCount++;
        return new Response(JSON.stringify(status(loadCount === 1 ? "2028-01-02T00:00:00.000Z" : "2028-01-09T00:00:00.000Z")), { status: 200 });
      }
      return new Response(JSON.stringify({ cycleId: "new-cycle", nextDueAt: "2028-01-09T00:00:00.000Z" }), { status: 201 });
    });
    const client = createSwitchClient(fetcher);
    await client.loadStatus();
    const outcome = await client.checkIn();
    expect(outcome.cycleId).toBe("new-cycle");
    expect(client.status.value?.nextDueAt).toBe("2028-01-09T00:00:00.000Z");
  });

  it("keeps the due date after a failed check-in", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/switch"
      ? new Response(JSON.stringify(status("2028-01-02T00:00:00.000Z")), { status: 200 })
      : new Response(JSON.stringify({ message: "Invalid proof" }), { status: 403 }));
    const client = createSwitchClient(fetcher);
    await client.loadStatus();
    await expect(client.checkIn("000000")).rejects.toThrow();
    expect(client.status.value?.nextDueAt).toBe("2028-01-02T00:00:00.000Z");
  });
});
