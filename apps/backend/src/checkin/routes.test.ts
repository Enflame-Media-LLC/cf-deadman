import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyCheckInProof, checkInPolicySchema, createCheckInTotpSecret, encryptSecret, decryptSecret, verifyTotp } from "./policy";
import { recordCheckIn } from "./routes";
import { saveRevision } from "../switch/repository";
import { claimOwner } from "../auth/setup";
import { createAuth } from "../auth/auth";

const startedAt = "2028-01-01T00:00:00.000Z";

async function claimTestOwner(): Promise<string> {
  await env.DB.prepare("DELETE FROM switches").run();
  await env.DB.prepare("DELETE FROM owner_slot").run();
  return (await claimOwner(env, {
    setupSecret: "test-setup-secret", email: "checkin@example.com", password: "correct horse battery staple",
  })).ownerId;
}

async function testTotp(secret: string): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = Uint8Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 30_000)));
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1] & 15;
  return (((((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000)).toString().padStart(6, "0");
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["outbox", "action_runs", "round_runs", "actions", "action_groups", "round_arming", "schedule_rounds", "schedule_revisions", "checkins", "checkin_attempts", "checkin_keys", "checkin_policy", "switches", "owner_slot", '"user"']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO owner_slot (id, owner_id, claim_nonce, claim_email, claim_started_at, claimed_at) VALUES (1, 'owner', 'claim', 'owner@example.com', ?, ?)")
    .bind(startedAt, startedAt).run();
  await env.DB.prepare("INSERT INTO switches (id, owner_id, cycle_id, cycle_started_at, updated_at) VALUES (1, 'owner', 'old-cycle', ?, ?)")
    .bind(startedAt, startedAt).run();
});

describe("check-in", () => {
  it("requires one enabled path", () => {
    expect(checkInPolicySchema.safeParse({ methods: [] }).success).toBe(false);
    expect(checkInPolicySchema.safeParse({ methods: ["api_key"] }).success).toBe(true);
  });

  it("uses a separate check-in TOTP", async () => {
    const secret = createCheckInTotpSecret();
    const cipher = await encryptSecret(env.DATA_ENCRYPTION_KEY, secret);
    expect(cipher).not.toContain(secret);
    expect(await decryptSecret(env.DATA_ENCRYPTION_KEY, cipher)).toBe(secret);
    expect(await verifyTotp(secret, "000000", new Date("2028-01-01T00:00:00Z"))).toBe(false);
  });

  it("bad keys never reset cycle", async () => {
    const ownerId = await claimTestOwner();
    await env.DB.prepare("INSERT INTO checkin_policy (id, methods_json, updated_at) VALUES (1, ?, ?)")
      .bind(JSON.stringify(["api_key"]), startedAt).run();
    const auth = createAuth(env, "http://localhost");
    const expired = await auth.api.createApiKey({ body: { userId: ownerId, name: "expired", permissions: { "check-in": ["create"] } } });
    const revoked = await auth.api.createApiKey({ body: { userId: ownerId, name: "revoked", permissions: { "check-in": ["create"] } } });
    for (const [key, expiresAt, revokedAt] of [
      [expired, "2020-01-01T00:00:00.000Z", null],
      [revoked, null, new Date().toISOString()],
    ] as const) {
      await env.DB.prepare("INSERT INTO checkin_keys (id, owner_id, key_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(key.id, ownerId, key.id, startedAt, expiresAt, revokedAt).run();
    }
    const before = await env.DB.prepare("SELECT cycle_id FROM switches WHERE id = 1").first<{ cycle_id: string }>();
    for (const token of ["invalid", expired.key, revoked.key]) {
      await expect(verifyCheckInProof(env, new Request("http://localhost/api/check-ins", {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      }))).rejects.toThrow();
    }
    for (let i = 0; i < 5; i++) {
      await expect(verifyCheckInProof(env, new Request("http://localhost/api/check-ins", {
        method: "POST", headers: { authorization: "Bearer rate-limited" },
      }))).rejects.toThrow();
    }
    await expect(verifyCheckInProof(env, new Request("http://localhost/api/check-ins", {
      method: "POST", headers: { authorization: "Bearer rate-limited" },
    }))).rejects.toMatchObject({ status: 429 });
    const after = await env.DB.prepare("SELECT cycle_id FROM switches WHERE id = 1").first<{ cycle_id: string }>();
    expect(after?.cycle_id).toBe(before?.cycle_id);
  });

  it("accepts each enabled proof", async () => {
    const ownerId = await claimTestOwner();
    const secret = createCheckInTotpSecret();
    await env.DB.prepare("INSERT INTO checkin_policy (id, methods_json, totp_secret_ciphertext, updated_at) VALUES (1, ?, ?, ?)")
      .bind(JSON.stringify(["session", "session_totp", "api_key", "api_key_totp"]),
        await encryptSecret(env.DATA_ENCRYPTION_KEY, secret), new Date().toISOString()).run();
    const login = await SELF.fetch("http://localhost/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "checkin@example.com", password: "correct horse battery staple" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const code = await testTotp(secret);
    const auth = createAuth(env, "http://localhost");
    const key = await auth.api.createApiKey({ body: { userId: ownerId, name: "test", permissions: { "check-in": ["create"] } } });
    await env.DB.prepare("INSERT INTO checkin_keys (id, owner_id, key_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(key.id, ownerId, key.id, new Date().toISOString()).run();
    for (const [expected, headers] of [
      ["session", { cookie }],
      ["session_totp", { cookie, "x-checkin-totp": code }],
      ["api_key", { authorization: `Bearer ${key.key}` }],
      ["api_key_totp", { authorization: `Bearer ${key.key}`, "x-checkin-totp": code }],
    ] as const) {
      const proof = await verifyCheckInProof(env, new Request("http://localhost/api/check-ins", { method: "POST", headers }));
      expect(proof.method).toBe(expected);
    }
  }, 30_000);

  it("check-in cancels pending old-cycle work", async () => {
    const revision = await saveRevision(env.DB, "owner", {
      rounds: [{ id: "r1", delay: { amount: 1, unit: "weeks" }, manualRearm: false, groups: [{ id: "g1", mode: "ordered" }] }],
      reviewedDeadlines: [{ roundId: "r1", dueAt: "2028-01-08T00:00:00.000Z" }],
    }, new Date(startedAt));
    const group = await env.DB.prepare("SELECT id FROM action_groups WHERE round_id = ?")
      .bind(revision.rounds[0].id).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO actions (id, group_id, ordinal, kind, config_ciphertext, failure_policy) VALUES ('action-1', ?, 0, 'webhook', 'encrypted', 'continue')")
      .bind(group!.id).run();
    await env.DB.prepare("INSERT INTO round_runs (id, cycle_id, revision_id, round_id, status, due_at) VALUES ('run-1', 'old-cycle', ?, ?, 'pending', ?)")
      .bind(revision.id, revision.rounds[0].id, "2028-01-08T00:00:00.000Z").run();
    await env.DB.prepare("INSERT INTO action_runs (id, round_run_id, cycle_id, revision_id, action_id, status) VALUES ('action-run-1', 'run-1', 'old-cycle', ?, 'action-1', 'pending')")
      .bind(revision.id).run();
    await env.DB.prepare("INSERT INTO outbox (id, action_run_id, payload_json, status, created_at) VALUES ('out-1', 'action-run-1', '{}', 'pending', ?)")
      .bind(startedAt).run();
    const result = await recordCheckIn(env.DB, { method: "session", sessionId: "session-1" }, new Date("2028-01-02T00:00:00Z"));
    expect(result.cycleId).not.toBe("old-cycle");
    expect(result.nextDueAt).toBe("2028-01-09T00:00:00.000Z");
    for (const table of ["round_runs", "action_runs", "outbox"]) {
      const row = await env.DB.prepare(`SELECT status FROM ${table} LIMIT 1`).first<{ status: string }>();
      expect(row?.status).toBe("canceled");
    }
  });

  it("key cannot administer and mutations require fresh admin TOTP", async () => {
    const response = await SELF.fetch("http://localhost/api/switch/schedule", {
      method: "PUT", headers: { authorization: "Bearer invalid", "content-type": "application/json" },
      body: JSON.stringify({ rounds: [] }),
    });
    expect(response.status).toBe(403);
  });

  it("issues a scoped key after fresh TOTP and accepts its check-in", async () => {
    await claimTestOwner();
    const password = "correct horse battery staple";
    const login = await SELF.fetch("http://localhost/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "checkin@example.com", password }),
    });
    const initialCookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const enroll = await SELF.fetch("http://localhost/api/auth/two-factor/enable", {
      method: "POST", headers: { "content-type": "application/json", cookie: initialCookie, origin: "http://localhost" },
      body: JSON.stringify({ password }),
    });
    expect(enroll.status).toBe(200);
    const { totpURI } = await enroll.json() as { totpURI: string };
    const code = await testTotp(new URL(totpURI).searchParams.get("secret")!);
    const verified = await SELF.fetch("http://localhost/api/auth/two-factor/verify-totp", {
      method: "POST", headers: { "content-type": "application/json", cookie: initialCookie, origin: "http://localhost" },
      body: JSON.stringify({ code, trustDevice: false }),
    });
    expect(verified.status).toBe(200);
    const adminCookie = verified.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const updatePolicy = await SELF.fetch("http://localhost/api/check-in-policy", {
      method: "PUT", headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ methods: ["api_key"] }),
    });
    expect(updatePolicy.status, await updatePolicy.clone().text()).toBe(200);
    const issue = await SELF.fetch("http://localhost/api/check-in-keys", {
      method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ name: "heartbeat" }),
    });
    expect(issue.status, await issue.clone().text()).toBe(201);
    const key = await issue.json() as { id: string; key: string };
    const checkin = await SELF.fetch("http://localhost/api/check-ins", {
      method: "POST", headers: { authorization: `Bearer ${key.key}` },
    });
    expect(checkin.status, await checkin.clone().text()).toBe(201);
    const cannotAdminister = await SELF.fetch("http://localhost/api/switch", {
      headers: { authorization: `Bearer ${key.key}` },
    });
    expect(cannotAdminister.status).toBe(403);
    const listed = await SELF.fetch("http://localhost/api/check-in-keys", { headers: { cookie: adminCookie } });
    expect((await listed.text())).not.toContain(key.key);
    const revoked = await SELF.fetch(`http://localhost/api/check-in-keys/${key.id}`, {
      method: "DELETE", headers: { cookie: adminCookie },
    });
    expect(revoked.status).toBe(200);
    const afterRevocation = await SELF.fetch("http://localhost/api/check-ins", {
      method: "POST", headers: { authorization: `Bearer ${key.key}` },
    });
    expect(afterRevocation.status).toBe(403);
  }, 30_000);
});
