import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../env";

const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, ...(required.length ? { required } : {}),
});
const string = { type: "string" };
const boolean = { type: "boolean" };
const dateTime = { type: "string", format: "date-time" };
const noContent = { description: "Successful response" };
const forbidden = { description: "Owner session or proof required" };
const checkInMethod = { type: "string", enum: ["session", "session_totp", "api_key", "api_key_totp"] };
const delay = object({ amount: { type: "integer", minimum: 1 }, unit: { type: "string", enum: ["days", "weeks", "months"] } }, ["amount", "unit"]);
const group = object({ id: string, mode: { type: "string", enum: ["ordered", "concurrent"] } }, ["id", "mode"]);
const round = object({ id: string, delay, manualRearm: boolean, groups: { type: "array", minItems: 1, items: group } }, ["id", "delay", "manualRearm", "groups"]);
const schedule = object({
  rounds: { type: "array", minItems: 1, items: round },
  reviewedDeadlines: { type: "array", items: object({ roundId: string, dueAt: dateTime }, ["roundId", "dueAt"]) },
}, ["rounds", "reviewedDeadlines"]);

const ownerSecurity = [{ ownerSession: [] }];
const freshSecurity = [{ freshAdminTotp: [] }];
const operation = (summary: string, responses: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  summary, responses, ...extra,
});

export const applicationOpenApi = {
  openapi: "3.1.0",
  info: { title: "CF Deadman API", version: "0.1.0", description: "One-owner deadman switch foundation API. The switch cannot be armed in this release." },
  components: {
    securitySchemes: {
      ownerSession: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "Better Auth owner session" },
      freshAdminTotp: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "Owner session with a TOTP proof from the past five minutes" },
      checkInKey: { type: "http", scheme: "bearer", description: "Scoped check-in key with check-in:create permission" },
    },
  },
  paths: {
    "/api/health": { get: operation("Worker health", { 200: { description: "Healthy", content: json(object({ status: { type: "string", const: "ok" } }, ["status"])) } }) },
    "/api/setup": { post: operation("Claim the only owner using the setup secret", {
      201: { description: "Owner claimed", content: json(object({ ownerId: string }, ["ownerId"])) },
      400: { description: "Invalid account details" }, 403: { description: "Setup denied or already claimed" },
    }, { requestBody: { required: true, content: json(object({ setupSecret: string, email: { type: "string", format: "email" }, password: string }, ["setupSecret", "email", "password"])) } }) },
    "/api/setup/status": { get: operation("Check whether the owner has been claimed", { 200: { description: "Setup state", content: json(object({ claimed: boolean }, ["claimed"])) } }) },
    "/api/switch": { get: operation("Read switch state and upcoming deadlines", {
      200: { description: "Switch status", content: json(object({ ownerId: string, activeRevisionId: { type: ["string", "null"] }, cycleId: string, cycleStartedAt: dateTime, armed: boolean, paused: boolean, nextDueAt: { type: ["string", "null"], format: "date-time" }, rounds: { type: "array", items: object({ id: string, dueAt: dateTime, manualRearm: boolean, armed: boolean }) } })) },
      403: forbidden,
    }, { security: ownerSecurity }) },
    "/api/switch/schedule": { put: operation("Save an immutable schedule revision after reviewing deadlines", {
      201: { description: "Revision saved" }, 400: { description: "Invalid schedule" }, 403: forbidden, 409: { description: "Deadline preview is stale" },
    }, { security: freshSecurity, requestBody: { required: true, content: json(schedule) } }) },
    "/api/switch/history": { get: operation("Read schedule revisions, check-ins, round runs, and action results", {
      200: { description: "Revision and run history" }, 403: forbidden,
    }, { security: ownerSecurity }) },
    "/api/switch/rounds/{id}/rearm": { post: operation("Rearm a manual-rearm round", {
      200: { description: "Round rearmed", content: json(object({ ok: boolean }, ["ok"])) }, 403: forbidden, 404: { description: "Round not found" },
    }, { security: freshSecurity, parameters: [{ name: "id", in: "path", required: true, schema: string }] }) },
    "/api/switch/paused": { put: operation("Pause or resume new round claims", {
      200: { description: "Pause state saved", content: json(object({ paused: boolean }, ["paused"])) }, 403: forbidden,
    }, { security: freshSecurity, requestBody: { required: true, content: json(object({ paused: boolean }, ["paused"])) } }) },
    "/api/check-ins": { post: operation("Confirm presence and start a new cycle", {
      201: { description: "Check-in accepted", content: json(object({ cycleId: string, nextDueAt: { type: ["string", "null"], format: "date-time" } }, ["cycleId", "nextDueAt"])) },
      403: { description: "Invalid or disabled proof" }, 429: { description: "Too many failed proofs" },
    }, { security: [{ ownerSession: [] }, { checkInKey: [] }], parameters: [{ name: "x-checkin-totp", in: "header", required: false, schema: { type: "string", pattern: "^[0-9]{6}$" }, description: "Separate check-in TOTP when enabled" }] }) },
    "/api/check-in-policy": {
      get: operation("Read enabled check-in methods", { 200: { description: "Check-in policy", content: json(object({ methods: { type: "array", items: checkInMethod }, hasSeparateTotp: boolean }, ["methods", "hasSeparateTotp"])) }, 403: forbidden }, { security: ownerSecurity }),
      put: operation("Set check-in methods and optionally rotate the separate TOTP", { 200: { description: "Policy saved; setup URI appears only when created" }, 400: { description: "Invalid policy" }, 403: forbidden }, {
        security: freshSecurity,
        requestBody: { required: true, content: json(object({ methods: { type: "array", minItems: 1, items: checkInMethod }, regenerateTotp: boolean }, ["methods"])) },
      }),
    },
    "/api/check-in-keys": {
      get: operation("List check-in key metadata without key values", { 200: { description: "Keys" }, 403: forbidden }, { security: ownerSecurity }),
      post: operation("Issue a scoped check-in key; its value appears once", { 201: { description: "Key issued", content: json(object({ id: string, key: string }, ["id", "key"])) }, 403: forbidden }, {
        security: freshSecurity,
        requestBody: { required: true, content: json(object({ name: string, expiresInSeconds: { type: "integer", minimum: 1 } }, ["name"])) },
      }),
    },
    "/api/check-in-keys/{id}": { delete: operation("Revoke a check-in key", { 200: { description: "Key revoked" }, 403: forbidden, 404: { description: "Key not found" } }, {
      security: freshSecurity, parameters: [{ name: "id", in: "path", required: true, schema: string }],
    }) },
    "/api/openapi.json": { get: operation("Application OpenAPI document", { 200: noContent }) },
    "/api/docs": { get: operation("Combined API reference", { 200: noContent }) },
  },
} as const;

const referenceHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CF Deadman API reference</title><style>
body{font:16px system-ui,sans-serif;max-width:900px;margin:3rem auto;padding:0 1rem;background:#0d1320;color:#eef4ff}
a{color:#8dd6ff}section{background:#172237;border:1px solid #30435d;border-radius:14px;padding:1.2rem;margin:1rem 0}
li{margin:.35rem 0}code{font-size:.85em;color:#a7e1c0}
</style></head><body><h1>CF Deadman API reference</h1><p>OpenAPI 3.1 schemas for the application and Better Auth.</p>
<section><h2>Application API</h2><p><a href="/api/openapi.json">Download application schema</a></p><ul id="app-routes"></ul></section>
<section><h2>Authentication API</h2><p><a href="/api/auth/open-api/generate-schema">Download Better Auth schema</a> · <a href="/api/auth/reference">Interactive Better Auth reference</a></p><ul id="auth-routes"></ul></section>
<script>for(const [url,id] of [['/api/openapi.json','app-routes'],['/api/auth/open-api/generate-schema','auth-routes']]) fetch(url).then(r=>r.json()).then(doc=>{const list=document.getElementById(id);for(const [path,methods] of Object.entries(doc.paths||{})) for(const [method,operation] of Object.entries(methods)) {const item=document.createElement('li');const code=document.createElement('code');code.textContent=method.toUpperCase()+' '+path;item.append(code,document.createTextNode(' — '+(operation.summary||'')));list.append(item)}}).catch(()=>{});</script>
</body></html>`;

export function registerDocsRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.get("/api/openapi.json", (context) => context.json(applicationOpenApi));
  app.get("/api/docs", (context) => context.html(referenceHtml));
}
