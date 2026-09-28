# Switch Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the one-owner Cloudflare Worker foundation that accepts authenticated check-ins and advances a durable, configurable multi-round schedule without duplicate action claims.

**Architecture:** One TypeScript Worker serves the Hono API and compiled Vue assets and handles cron and queue events. D1 stores owner, schedule, check-in, and execution state; a transactional outbox bridges D1 and Cloudflare Queues. Provider executors are an interface in this slice, with a fake used by tests; production arming waits for the delivery-actions slice.

**Tech Stack:** TypeScript, Hono, `@hono/zod-openapi`, Better Auth with D1/TOTP/API-key/OpenAPI plugins, Cloudflare D1 and Queues, Vue 3, shadcn-vue, Vitest with `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-09-27-switch-foundation-design.md`

## Global Constraints

- One owner, one active switch, and one deployable Worker per Cloudflare deployment.
- Backend code lives in `apps/backend`; Vue code lives in `apps/web`.
- Round delays are positive days, weeks, or calendar months from the preceding **scheduled** deadline; month addition clamps to the last day.
- Accepted check-ins increment the cycle and cancel pending old-cycle work; already started work may finish.
- A manual-rearm round stays disarmed across later cycles until the owner rearms it; disarmed rounds are skipped without stopping later rounds.
- Groups are ordered; actions within a group are ordered or concurrent. Failure policy is `continue`, `stop_group`, or `stop_round`.
- Application and Better Auth routes have published OpenAPI 3.1 schemas. Secrets and token values are never returned after creation.
- No production outbound action adapter or arming UI is exposed in this slice.

## Review Focus

- Two concurrent owner claims with the correct setup secret: exactly one owner wins; the other cannot obtain owner privileges (Task 3 test).
- Invalid, expired, or revoked automation key: the cycle and deadline remain unchanged (Task 5 test).
- A queued old-cycle action delivered after check-in: it is skipped and never calls the executor (Task 6 test).
- January 31 plus one calendar month in a leap and non-leap year: the due date clamps to the correct February day (Task 2 test).
- A concurrent action fails with `stop_round`: unclaimed siblings and future groups skip, while already started siblings finish (Task 7 test).

---

## File map

- Root `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`: one build, local dev, test, migration, and Worker deployment entry point.
- `apps/backend/src/index.ts`, `app.ts`, `env.ts`: Worker event handlers, Hono app, and bindings. Keep business rules out of the entry point.
- `apps/backend/migrations/0001_foundation.sql`: owner singleton, auth and admin-TOTP proof tables, switch/revision/round/group/action, check-in, run, and outbox tables with unique execution keys.
- `apps/backend/src/domain/types.ts`, `deadlines.ts`: shared schedule/execution contracts and pure deadline calculation.
- `apps/backend/src/auth/{auth,setup,guard}.ts`: Better Auth construction, one-owner claim, owner and fresh-TOTP guards.
- `apps/backend/src/switch/{repository,routes}.ts`: validated schedule revisions, status, rearm, and history queries.
- `apps/backend/src/checkin/{policy,routes}.ts`: check-in proof evaluation and cycle reset.
- `apps/backend/src/execution/{scheduler,outbox,coordinator,executor}.ts`: due-round discovery, reliable queue publication, action claims, and group progression.
- `apps/backend/src/api/docs.ts`: application and Better Auth OpenAPI endpoints and combined reference page.
- `apps/web/src/{App.vue,api.ts}` and focused `pages/` and `components/`: setup, sign-in/TOTP, dashboard/check-in, policy, and read-only run views.
- Tests sit beside backend modules as `*.test.ts`; web tests sit beside views as `*.test.ts`.

### Task 1: Worker shell and durable schema

**Files:** Create root config files; `apps/backend/src/{index,app,env}.ts`; `apps/backend/src/domain/types.ts`; `apps/backend/migrations/0001_foundation.sql`; `apps/backend/src/app.test.ts`.

**Interfaces:** Produce `type ActionJob = { runId: string; cycleId: string; revisionId: string; actionId: string }` in `domain/types.ts`, `type Env = { DB: D1Database; ACTIONS: Queue<ActionJob>; SETUP_SECRET: string; BETTER_AUTH_SECRET: string; DATA_ENCRYPTION_KEY: string; ASSETS: Fetcher }` in `env.ts`, and `createApp(): OpenAPIHono<{ Bindings: Env }>` in `app.ts`.

- [ ] **Step 1: Create** the root package manifest, lockfile, TypeScript config, Vitest config, and Wrangler config with a one-minute cron and declared D1, Queue, Assets, and secret bindings; run `npm install` and expect success.
- [ ] **Step 2: Write a failing Worker test** named `serves health and migrates foundation` with `expect(response.status).toBe(200)`, `expect(await response.json()).toEqual({ status: "ok" })`, and assertions that SQLite lists the owner singleton, schedule revision, action run, and outbox tables.
- [ ] **Step 3: Run** `npm test -- apps/backend/src/app.test.ts`; expect failure because the Worker entry point and schema do not exist.
- [ ] **Step 4: Implement** the D1 migration, `createApp()`, and `fetch/scheduled/queue` handlers in `index.ts`. Initially scheduled and queue handlers call explicit no-op functions; `/api/health` works. Keep the web asset build as an empty shell target until Task 8.
- [ ] **Step 5: Run** `npm test -- apps/backend/src/app.test.ts` and `npm run typecheck`; expect both to pass.
- [ ] **Step 6: Commit** only this task's files with `feat: scaffold single-worker foundation`.

### Task 2: Pure schedule and execution contracts

**Files:** Create `apps/backend/src/domain/{types,deadlines,deadlines.test}.ts`.

**Interfaces:** Add `type Delay = { amount: number; unit: "days" | "weeks" | "months" }`, `type GroupMode = "ordered" | "concurrent"`, `type FailurePolicy = "continue" | "stop_group" | "stop_round"`, and `type ActionDefinition = { id: string; kind: "email" | "webhook" | "sms" | "browser"; config: unknown; failurePolicy: FailurePolicy }` to `types.ts`. Produce `computeDeadlines(startAt: Date, rounds: readonly { id: string; delay: Delay }[]): readonly { roundId: string; dueAt: Date }[]`.

- [ ] **Step 1: Write failing tests** named `clamps leap February`, `clamps non-leap February`, `anchors later rounds to scheduled deadlines`, and `rejects nonpositive delays`. Assert `computeDeadlines(new Date("2028-01-31T00:00:00Z"), [{id:"r1",delay:{amount:1,unit:"months"}}])[0].dueAt.toISOString()` equals `"2028-02-29T00:00:00.000Z"`; use `"2027-02-28T00:00:00.000Z"` for the non-leap case. Assert zero and negative amounts throw.
- [ ] **Step 2: Run** `npm test -- apps/backend/src/domain/deadlines.test.ts`; expect the missing `computeDeadlines` failure.
- [ ] **Step 3: Implement** the exported types and `computeDeadlines`; use UTC calendar fields and end-of-month clamp, returning new `Date` values without mutating inputs.
- [ ] **Step 4: Run** the focused test and `npm run typecheck`; expect pass.
- [ ] **Step 5: Commit** with `feat: calculate round deadlines`.

### Task 3: Single-owner Better Auth setup

**Files:** Create `apps/backend/src/auth/{auth,setup,guard,setup.test}.ts`; extend `app.ts` and the migration if Better Auth generates required tables.

**Interfaces:** Produce `type OwnerSession = { userId: string; sessionId: string; adminTotpVerifiedAt: Date | null }`, `createAuth(env: Env, requestUrl: string)`, `claimOwner(env: Env, input: { setupSecret: string; email: string; password: string }): Promise<{ ownerId: string }>`, `requireOwner(c): Promise<OwnerSession>`, and `requireFreshAdminTotp(c): Promise<OwnerSession>`; mount Better Auth at `/api/auth/*`.

- [ ] **Step 1: Write failing tests** named `claims one owner`, `rejects wrong setup secret`, `concurrent claims yield one owner`, `blocks direct signup`, and `resumes pending claim`. For concurrent claims, assert `(await Promise.allSettled([claimOwner(env, a), claimOwner(env, b)])).filter(x => x.status === "fulfilled")` has length `1`; assert the rejected claimant receives `403` from `GET /api/switch`.
- [ ] **Step 2: Run** `npm test -- apps/backend/src/auth/setup.test.ts`; expect missing setup/auth routes.
- [ ] **Step 3: Implement** per-request Better Auth on D1 with email/password, TOTP, API-key, and OpenAPI plugins. Reserve the singleton owner slot with a conditional D1 write before creating the Better Auth user; persist pending claim metadata for idempotent retry; block direct signup even before claim; finish with a claimed owner ID. Record a successful password-plus-TOTP sign-in proof against its new session ID; `requireFreshAdminTotp` accepts that proof only for five minutes, and the UI prompts a new sign-in when stale. Do not enable trusted-device bypass for admin sign-in. Require verified TOTP before future arming.
- [ ] **Step 4: Run** focused tests and `npm run typecheck`; expect pass.
- [ ] **Step 5: Commit** with `feat: add single-owner authentication`.

### Task 4: Schedule revisions and owner API

**Files:** Create `apps/backend/src/switch/{repository,routes,routes.test}.ts`; extend `app.ts`.

**Interfaces:** Produce `saveRevision(db: D1Database, ownerId: string, input: ScheduleInput, now: Date): Promise<ScheduleRevision>`, `getSwitchStatus(db: D1Database, now: Date): Promise<SwitchStatus>`, `rearmRound(db: D1Database, roundId: string, now: Date): Promise<void>`, and `setSwitchPaused(db: D1Database, paused: boolean, now: Date): Promise<void>`. Define `ScheduleInput` with ordered rounds and groups using Zod schemas exported from `routes.ts`; public action creation waits for the delivery-actions slice.

- [ ] **Step 1: Write failing tests** named `rejects empty schedule`, `previews exact deadlines`, `creates immutable revision`, `keeps manual rearm disarmed`, and `pause blocks claims`. Assert empty rounds return `400`, editing yields a new revision ID while the old revision remains readable, and a skipped disarmed round leaves the next round's `dueAt` unchanged.
- [ ] **Step 2: Run** `npm test -- apps/backend/src/switch/routes.test.ts`; expect missing routes.
- [ ] **Step 3: Implement** owner-only `GET /api/switch`, `PUT /api/switch/schedule`, `GET /api/switch/history`, `POST /api/switch/rounds/{id}/rearm`, and `PUT /api/switch/paused`, plus the repository functions. Revisions are immutable; edits become effective only after explicit deadline review in the request contract. Keep `armed=false` while no production executor exists.
- [ ] **Step 4: Run** focused tests and `npm run typecheck`; expect pass.
- [ ] **Step 5: Commit** with `feat: persist switch schedule revisions`.

### Task 5: Configurable check-in proofs and cycle reset

**Files:** Create `apps/backend/src/checkin/{policy,routes,routes.test}.ts`; extend `app.ts` and auth guard.

**Interfaces:** Produce `verifyCheckInProof(env: Env, request: Request): Promise<{ method: CheckInMethod; keyId?: string; sessionId?: string }>`, `recordCheckIn(db: D1Database, proof: CheckInProof, at: Date): Promise<{ cycleId: string; nextDueAt: Date | null }>`, and `type CheckInMethod = "session" | "session_totp" | "api_key" | "api_key_totp"`.

- [ ] **Step 1: Write failing tests** named `accepts each enabled proof`, `uses a separate check-in TOTP`, `bad keys never reset cycle`, `requires one enabled path`, `key cannot administer`, `requires fresh admin TOTP`, and `check-in cancels pending old-cycle work`. In `bad keys never reset cycle`, read the generation before and after invalid, expired, revoked, and rate-limited requests and assert equality each time; assert the check-in-only key receives `403` from a schedule mutation.
- [ ] **Step 2: Run** `npm test -- apps/backend/src/checkin/routes.test.ts`; expect missing check-in routes.
- [ ] **Step 3: Implement** `POST /api/check-ins`, `GET/PUT /api/check-in-policy`, and owner-only key issuance/revocation. Use Better Auth API-key permissions `check-in:create`; block direct HTTP calls to Better Auth's key mutation routes so issuance/revocation always passes the app's fresh-admin-TOTP guard. Do not enable administrative sessions for keys. Store the separate check-in TOTP secret encrypted with `DATA_ENCRYPTION_KEY`, rate-limit verification, and atomically increment the cycle, cancel pending old-cycle work, and record the accepted method.
- [ ] **Step 4: Run** focused tests and `npm run typecheck`; expect pass.
- [ ] **Step 5: Commit** with `feat: support scoped check-in methods`.

### Task 6: Cron discovery, outbox, and safe queue claims

**Files:** Create `apps/backend/src/execution/{scheduler,outbox,scheduler.test}.ts`; wire `scheduled()` in `index.ts`.

**Interfaces:** Produce `tickSchedule(env: Env, now: Date): Promise<void>`, `dispatchOutbox(env: Env): Promise<void>`, and `claimAction(db: D1Database, job: ActionJob, now: Date): Promise<"claimed" | "stale" | "duplicate">`.

- [ ] **Step 1: Write failing tests** named `claims one due round`, `waits for prior round`, `recovers lost publish`, `retries after D1 failure`, `claims duplicate once`, and `skips old cycle`. In `skips old cycle`, submit a check-in before delivering the old job, assert `claimAction(db, oldJob, now)` equals `"stale"`, and assert the fake executor has zero calls. In `recovers lost publish`, assert one outbox row remains pending after a rejected send and is published on the next tick.
- [ ] **Step 2: Run** `npm test -- apps/backend/src/execution/scheduler.test.ts`; expect missing scheduler functions.
- [ ] **Step 3: Implement** due-round conditional claims and D1 outbox records, then publish pending outbox rows to Queues. Respect `armed=false` and paused state before new claims. `claimAction` checks the persisted cycle and pending status in one conditional state transition. Queue messages carry IDs only, never secret values or mutable action definitions. Log transition failures with structured IDs, without secret values.
- [ ] **Step 4: Run** focused tests and `npm run typecheck`; expect pass.
- [ ] **Step 5: Commit** with `feat: schedule durable action jobs`.

### Task 7: Ordered/concurrent group coordinator

**Files:** Create `apps/backend/src/execution/{executor,coordinator,coordinator.test}.ts`; wire `queue()` in `index.ts`.

**Interfaces:** Produce `interface ActionExecutor { execute(action: ActionDefinition, runId: string): Promise<"succeeded" | "failed" | "needs_review"> }` and `handleActionMessage(env: Env, job: ActionJob, executor: ActionExecutor, now: Date): Promise<void>`.

- [ ] **Step 1: Write failing tests** named `orders actions`, `starts concurrent siblings`, `waits for started siblings`, `continues after failure`, `stops group`, `stops round`, and `ignores duplicate delivery`. In `stops round`, hold one sibling in progress, fail another with `stop_round`, then assert unclaimed siblings and future groups are `skipped`; release the held sibling and assert it records `succeeded` exactly once.
- [ ] **Step 2: Run** `npm test -- apps/backend/src/execution/coordinator.test.ts`; expect missing coordinator.
- [ ] **Step 3: Implement** group progression using conditional D1 transitions and the Task 6 claim function. Keep the real Worker consumer unarmed and incapable of calling an external provider; inject a fake executor in tests. Record failed, skipped, canceled, and needs-review reasons.
- [ ] **Step 4: Run** focused tests and `npm run typecheck`; expect pass.
- [ ] **Step 5: Commit** with `feat: coordinate action groups`.

### Task 8: Web shell, API docs, and foundation smoke

**Files:** Create `apps/web/src/{App.vue,api.ts}` and focused `pages/`/`components/` with adjacent tests; create `apps/backend/src/api/{docs,docs.test}.ts`; complete root Vite build and README setup instructions.

**Interfaces:** Consume `GET /api/switch`, `POST /api/check-ins`, `GET/PUT /api/check-in-policy`, owner setup/auth routes, and history routes. Produce `/api/openapi.json`, Better Auth schema endpoint, and `/api/docs` with both schemas.

- [ ] **Step 1: Write failing tests** named `claims and signs in`, `shows local deadline`, `reports check-in outcome`, `explains all enabled paths`, `does not offer arming`, and `documents every route`. Assert the dashboard renders its exact local due date, successful check-in replaces that due date, failed check-in leaves it unchanged, no `Arm switch` control exists, and `/api/docs` lists both application and Better Auth schema URLs.
- [ ] **Step 2: Run** `npm test -- apps/web apps/backend/src/api/docs.test.ts`; expect missing pages and docs routes.
- [ ] **Step 3: Implement** the Vue/shadcn-vue shell and shared typed API client, serve built assets from the Worker, expose the two OpenAPI sources, and document local D1 migration and setup. Keep full editing, providers, browser steps, and iOS out of this slice.
- [ ] **Step 4: Run** `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`; expect all to pass. Run a local Worker smoke that claims one owner, enrolls TOTP, submits a check-in, and reads status; expect the deadline to reset and no outbound action to run.
- [ ] **Step 5: Commit** with `feat: add owner web shell and API docs`.

## Completion handoff

Review the final diff against the spec and all five Review Focus cases. Record the local test/build output and any unavailable Cloudflare account integration separately. The next spec starts delivery adapters; the foundation must remain unarmable until an actual outbound adapter is configured and tested.
