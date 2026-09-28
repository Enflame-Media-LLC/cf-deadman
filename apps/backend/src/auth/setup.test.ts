import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimOwner } from "./setup";

const setupSecret = "test-setup-secret-at-least-thirty-two-characters";

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function currentTotp(secret: string): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const keyBytes = Uint8Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
    Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2));
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 30_000)));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1] & 15;
  const code = (((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000;
  return code.toString().padStart(6, "0");
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM switches").run();
  await env.DB.prepare("DELETE FROM owner_slot").run();
  await env.DB.prepare('DELETE FROM "user"').run();
});

describe("single owner", () => {
  it("claims one owner", async () => {
    const owner = await claimOwner(env, { setupSecret, email: "owner@example.com", password: "correct horse battery staple" });
    expect(owner.ownerId).toBeTruthy();
    const count = await env.DB.prepare('SELECT count(*) AS n FROM "user"').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects wrong setup secret", async () => {
    await expect(claimOwner(env, { setupSecret: "wrong", email: "a@example.com", password: "correct horse battery staple" })).rejects.toThrow();
  });

  it("rejects a weak configured setup secret", async () => {
    await expect(claimOwner({ ...env, SETUP_SECRET: "short" }, {
      setupSecret: "short", email: "owner@example.com", password: "correct horse battery staple",
    })).rejects.toThrow();
    expect(await env.DB.prepare("SELECT id FROM owner_slot").first()).toBeNull();
  });

  it("rejects malformed signup without reserving the owner", async () => {
    await expect(claimOwner(env, { setupSecret, email: "invalid", password: "correct horse battery staple" })).rejects.toThrow();
    const row = await env.DB.prepare("SELECT id FROM owner_slot").first();
    expect(row).toBeNull();
  });

  it("blocks direct signup", async () => {
    const response = await SELF.fetch("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "intruder@example.com", password: "correct horse battery staple", name: "intruder" }),
    });
    expect(response.status).toBe(403);
  });

  it("blocks owner deletion through Better Auth", async () => {
    const response = await SELF.fetch("http://localhost/api/auth/delete-user", { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("concurrent claims yield one owner", async () => {
    const attempts = await Promise.allSettled([
      claimOwner(env, { setupSecret, email: "one@example.com", password: "correct horse battery staple" }),
      claimOwner(env, { setupSecret, email: "two@example.com", password: "correct horse battery staple" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const row = await env.DB.prepare("SELECT owner_id FROM owner_slot WHERE id = 1").first<{ owner_id: string }>();
    expect(row?.owner_id).toBeTruthy();
  });

  it("resumes pending claim", async () => {
    await env.DB.prepare("INSERT INTO owner_slot (id, claim_nonce, claim_email, claim_started_at) VALUES (1, ?, ?, ?)")
      .bind("incomplete", "owner@example.com", new Date().toISOString()).run();
    const owner = await claimOwner(env, { setupSecret, email: "owner@example.com", password: "correct horse battery staple" });
    expect(owner.ownerId).toBeTruthy();
  });

  it("records fresh owner TOTP proof", async () => {
    const email = "totp@example.com";
    const password = "correct horse battery staple";
    await claimOwner(env, { setupSecret, email, password });
    const login = await SELF.fetch("http://localhost/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = cookieHeader(login);
    expect(sessionCookie).toContain("session_token");
    const enroll = await SELF.fetch("http://localhost/api/auth/two-factor/enable", {
      method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie, origin: "http://localhost" },
      body: JSON.stringify({ password }),
    });
    expect(enroll.status, await enroll.clone().text()).toBe(200);
    const enrollment = await enroll.json() as { totpURI: string };
    const secret = new URL(enrollment.totpURI).searchParams.get("secret");
    expect(secret).toBeTruthy();
    const verify = await SELF.fetch("http://localhost/api/auth/two-factor/verify-totp", {
      method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie, origin: "http://localhost" },
      body: JSON.stringify({ code: await currentTotp(secret!), trustDevice: false }),
    });
    expect(verify.status).toBe(200);
    const proofs = await env.DB.prepare("SELECT count(*) AS n FROM admin_totp_proofs").first<{ n: number }>();
    expect(proofs?.n).toBe(1);
  }, 30_000);
});
