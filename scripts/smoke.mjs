import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const base = process.env.CF_DEADMAN_URL ?? "http://127.0.0.1:8787";
const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split("\n")
  .filter((line) => line.includes("=")).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
const email = "smoke-owner@example.com";
const password = "correct horse battery staple";

function cookies(response) {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
}

async function call(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { origin: base } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return { response, value };
}

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
    Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000;
  return value.toString().padStart(6, "0");
}

const health = await call("/api/health");
if (health.value.status !== "ok") throw new Error("Worker health response failed");
const page = await fetch(base);
if (!page.ok || !(await page.text()).includes("CF Deadman")) throw new Error("Vue asset was not served");
const setupState = await call("/api/setup/status");
if (!setupState.value.claimed) {
  await call("/api/setup", { method: "POST", body: { setupSecret: vars.SETUP_SECRET, email, password } });
}
const login = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password } });
const firstCookie = cookies(login.response);
const enrollment = await call("/api/auth/two-factor/enable", {
  method: "POST", cookie: firstCookie, body: { password },
});
const secret = new URL(enrollment.value.totpURI).searchParams.get("secret");
if (!secret) throw new Error("TOTP enrollment URI missing a secret");
const verified = await call("/api/auth/two-factor/verify-totp", {
  method: "POST", cookie: firstCookie, body: { code: totp(secret), trustDevice: false },
});
const ownerCookie = cookies(verified.response) || firstCookie;
const initial = await call("/api/switch", { cookie: ownerCookie });
const due = new Date(initial.value.cycleStartedAt);
due.setUTCDate(due.getUTCDate() + 7);
await call("/api/switch/schedule", {
  method: "PUT", cookie: ownerCookie,
  body: {
    rounds: [{ id: "smoke-round", delay: { amount: 1, unit: "weeks" }, manualRearm: false,
      groups: [{ id: "smoke-group", mode: "ordered" }] }],
    reviewedDeadlines: [{ roundId: "smoke-round", dueAt: due.toISOString() }],
  },
});
const before = await call("/api/switch", { cookie: ownerCookie });
const accepted = await call("/api/check-ins", { method: "POST", cookie: ownerCookie });
const after = await call("/api/switch", { cookie: ownerCookie });
if (before.value.cycleId === after.value.cycleId || before.value.nextDueAt === after.value.nextDueAt ||
    accepted.value.nextDueAt !== after.value.nextDueAt || after.value.armed) {
  throw new Error("Check-in did not reset the schedule safely");
}
console.log("Smoke passed: owner claim, TOTP, schedule, check-in reset, Vue assets; no outbound action.");
