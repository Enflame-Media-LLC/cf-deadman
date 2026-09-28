# Deadman switch foundation design

Date: 2026-09-27

## Purpose and approved product direction

Build an open-source, self-hosted deadman switch for one owner per Cloudflare deployment. The owner checks in through a web app, iOS app, or an explicitly enabled API method. If check-ins stop, an ordered schedule fires rounds of actions. Every round may eventually contain email, webhook, SMS, and guided browser actions. Owners can group actions for ordered or concurrent execution and select whether each action failure continues, stops its group, or stops its round.

The complete product includes a Vue/TypeScript web app using shadcn-vue, a TypeScript Hono Worker API, Better Auth, and a native iOS app. This document specifies the **first implementation slice: switch foundation**. It establishes the deployment, access, schedule, orchestration, API, and minimal web flow. The later slices below complete the approved product. The foundation is an implementation milestone, not a releasable deadman switch with outbound actions.

## Repository and deployment shape

Use one public repository and one deployable Cloudflare Worker. Keep backend source in `apps/backend` and Vue source in `apps/web`; the root build embeds compiled web assets into the Worker deployment. The Worker has HTTP, scheduled, and queue handlers. Use Cloudflare D1 for durable state and a Cloudflare Queue for action jobs. Configure one UTC cron trigger, initially every minute. The iOS client later targets the same Worker URL. A root Wrangler configuration and deploy script will support a single Deploy to Cloudflare button after the product's delivery adapters and setup wizard are ready.

Cloudflare's deploy button provisions resources declared in Wrangler but does not deploy multiple Workers from a monorepo in one click. The single-Worker shape preserves the requested easy deployment. Cron firing and queue delivery are asynchronous; the UI must describe deadlines as scheduled times, not guarantee execution at the exact second.

## Components and boundaries

- **Auth and owner setup:** constructs Better Auth per request using the D1 binding, serves Better Auth routes, enforces a one-owner claim, and exposes an owner-only session guard. It does not decide whether a round is due.
- **Check-in policy:** validates one of the enabled check-in methods, records the method and actor, and asks the schedule service to start a new cycle. It does not administer the account.
- **Schedule service:** computes round deadlines, advances cycles, applies manual rearm state, and decides which round is eligible. It receives an explicit clock for deterministic tests.
- **Execution coordinator:** stores group/action run state, starts ordered or concurrent groups, applies action-level failure rules, and queues eligible action attempts. It depends on an executor interface, not provider code.
- **Worker entry point:** routes Hono HTTP requests, invokes the scheduler from `scheduled()`, and invokes the coordinator from `queue()`.
- **Web shell:** provides owner claim, sign-in and TOTP enrollment, dashboard status, check-in, check-in policy settings, and read-only schedule/run views. Full action editing follows in a later slice.

Keep domain types and validation schemas independent of Hono and Cloudflare bindings so web and future iOS clients can consume stable API contracts.

## Owner setup and authentication

A deployment requires a high-entropy setup secret configured as a Worker secret. The setup endpoint checks it and atomically claims a unique owner slot in D1. Only the claimed owner ID is authorized for application routes. Public Better Auth sign-up is closed after claim; it must not provide a route for an unclaimed account to become owner. A partially failed claim remains recoverable by presenting the setup secret, without admitting a second owner. The setup secret cannot be used for normal administration after claim.

Better Auth provides email/password sessions and TOTP with recovery codes. TOTP enrollment is required before arming. The web client uses secure session cookies. Administration and changes to check-in policy require an owner session and a recent admin TOTP challenge. An iOS session mechanism will be added in the iOS slice without weakening this route guard.

The owner may enable these independent check-in paths: authenticated owner session; owner session plus a distinct check-in TOTP; Better Auth API key scoped only to `check-in:create`; and that API key plus the distinct check-in TOTP. API keys are sent in a header, never a URL, and have expiry, rate limiting, rotation, and revocation. An API key does not create an administrative session. At least one check-in path must remain enabled. The settings UI states that any enabled path can reset the deadline. Failed check-ins do not change the schedule. Every accepted check-in records time, path, and key ID or owner session ID.

## Schedule model and invariants

There is one active switch with an ordered list of rounds. Each round has a positive delay from the previous **scheduled deadline**; the first delay is from the most recent accepted check-in. Delays support days, weeks, and calendar months. Calendar arithmetic uses a documented end-of-month clamp rule, with exact UTC instants persisted; the web app displays them in the owner's chosen timezone. Editing an armed schedule requires a review of newly computed deadlines and creates a new schedule revision.

An accepted check-in atomically increments the switch cycle/generation, writes check-in history, computes new deadlines, and cancels all pending work from the old generation. Work already claimed and started may finish. A queued message from an older generation that has not claimed its action is skipped. Each execution and queue message includes switch ID, schedule revision, cycle ID, round ID, group ID, and action ID.

Each round may be marked **manual rearm**. After that round fires, it becomes disarmed for future cycles until the owner explicitly rearms it. A disarmed round is recorded as skipped when its next deadline arrives; later round deadlines still follow the configured timeline. A check-in does not automatically rearm it. Completed historical actions are immutable.

Rounds are evaluated in order. A later due round waits for the previous round to become terminal, then starts if its own scheduled deadline has passed. A failed round is terminal and does not prevent later rounds. Pausing or disarming the whole switch prevents new claims but does not undo an action already running.

## Group and failure semantics

A round has ordered groups. A group runs its actions either in configured order or concurrently. The next group starts after all started actions in the current group reach a terminal state. An action failure has one of three policies:

- **Continue:** record failure and run the remaining actions and groups.
- **Stop group:** skip unstarted actions in that group, then continue with the next group.
- **Stop round:** skip all unstarted actions and groups in that round. Later rounds keep their scheduled deadlines.

In concurrent groups, a failure cannot cancel an already started sibling; siblings that have not claimed their attempt are skipped according to the policy. An action's terminal state is succeeded, failed, skipped, or needs review. Group and round states are derived from their child records and control flags, not guessed from queue delivery order.

## D1 state and queue recovery

The foundation schema includes owner setup state; check-in policy and history; switch, immutable schedule revisions, rounds, groups, and action definitions; per-cycle round/group/action runs; manual rearm state; and an outbox for queue dispatch. Unique keys on cycle/revision/action identity prevent duplicate runs. State transitions use conditional SQL updates and D1 batches where multiple statements must be atomic. Reads that decide a claim must be followed by a conditional write so concurrent cron, HTTP, and queue invocations cannot both win.

Cron scans due switch state and creates run and outbox records in D1. A dispatcher publishes outbox entries to the queue and marks them published. If publishing fails after the database write, a later cron pass republishes. Queue consumers use the action run ID to claim only pending work and check that the cycle is still current. A repeated queue message observes the existing claim and does not execute a second time. If a provider call later returns an ambiguous result, the executor contract supports `needs_review`; irreversible browser actions will never be automatically retried in that state. The first slice uses a fake executor only in tests; no production outbound action adapter is exposed before slice two.

## API and basic web flow

Use Hono with `@hono/zod-openapi` for typed, validated application routes and a versioned OpenAPI 3.1 document. Expose owner setup, switch status, accepted check-in, check-in policy and key management, schedule read/revision endpoints, manual rearm, and run history in this slice. Mutating requests use explicit validation and stable error codes. Better Auth routes are mounted under `/api/auth`; its OpenAPI plugin supplies a separate auth schema shown alongside the application schema. Review generated auth operations because the Better Auth plugin is still evolving.

The basic Vue shell shows setup, sign-in, TOTP enrollment, switch state, next deadline, check-in, enabled check-in paths, and history. Arming is unavailable until TOTP is enrolled and at least one deliverable action adapter exists in a later slice. The first slice's web UI does not offer nonfunctional action buttons.

## Failure handling and observability

Every state transition stores a timestamp and reason. Queue publish failures remain in the outbox for recovery. Unexpected schedule or database errors surface in structured Worker logs and leave due work eligible for the next scan. API responses never expose secrets, API keys after creation, TOTP seeds after enrollment, or raw browser step values. The execution history distinguishes scheduled, queued, started, succeeded, failed, skipped, canceled, and needs-review states. It shows the check-in source and schedule revision used for a run.

## Verification and acceptance criteria

Use the Cloudflare Workers Vitest integration against D1, scheduled events, and queue events. Test time with an injected clock. Include scenarios for calendar-month boundaries, multiple overdue rounds, check-in versus cron claim, check-in versus queued action, duplicate queue delivery, failed outbox publish, manual rearm across cycles, ordered and concurrent groups, and each failure policy. API tests verify one-owner setup, closed sign-up, key-only check-in scope, independent check-in TOTP, and OpenAPI route coverage. Web tests verify setup, sign-in, check-in feedback, and deadline display. Typecheck, lint, tests, and production build are required gates.

The slice is complete when a fresh local deployment can be claimed by one owner, configured with check-in methods, checked in through the web and API, and advanced through recorded schedule rounds using test execution events, with no duplicate action claim under queue redelivery. It cannot be armed for real outbound delivery until slice two.

## Later implementation slices

1. **Delivery actions:** Cloudflare Email Service, Resend, and custom SMTP with TLS on ports 465/587; Twilio SMS; signed HTTPS webhooks; provider setup, encrypted credentials, connection tests, and real executor adapters. SMTP port 25 and plaintext SMTP are rejected because Workers blocks port 25. This slice enables arming when configured delivery actions pass validation.
2. **Browser actions and full web editor:** Cloudflare Browser Run with a guided step editor and versioned developer templates; encrypted website secrets; controlled tests; destructive-step review; and detailed outcomes. A website challenge or uncertain interrupted result becomes a visible failure or needs-review state.
3. **iOS app and release polish:** native iOS sign-in, check-in, status, history, local reminders, Keychain credential storage, end-to-end tests, deployment documentation, and the Deploy to Cloudflare button. The server remains authoritative when the phone is offline.

The product design approved for these slices also requires the full web editor for ordered/concurrent groups, per-action failure rules, provider management, template review, manual rearm, and execution history. Each later slice receives its own focused spec and plan before implementation.

## Source notes

- [Deploy to Cloudflare button and monorepo limits](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [D1 batch atomicity](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Queues at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Better Auth Hono integration](https://better-auth.com/docs/integrations/hono)
- [Better Auth API keys](https://better-auth.com/docs/plugins/api-key)
- [Better Auth OpenAPI plugin](https://better-auth.com/docs/plugins/open-api)
- [Cloudflare Browser Run Playwright](https://developers.cloudflare.com/browser-run/playwright/)
- [Workers TCP sockets and SMTP port 25 restriction](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
