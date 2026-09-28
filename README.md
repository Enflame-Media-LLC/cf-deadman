# CF Deadman

An open-source, one-owner deadman switch for Cloudflare Workers. This foundation release provides owner setup, Better Auth with administrator TOTP, configurable check-in proofs, immutable schedule revisions, durable cron and queue coordination, a Vue dashboard, and OpenAPI 3.1 documentation.

**Outbound delivery is not enabled in this release.** The switch stays unarmed until email, SMS, webhook, and browser adapters are added and verified. The web shell provides check-in and policy management; schedule revisions can currently be saved through the API after reviewing exact deadlines. The native iOS client is a later release slice.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Enflame-Media-LLC/cf-deadman)

Cloudflare's [Deploy button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) clones the public repository and provisions the D1 database and Queue declared in `wrangler.jsonc`. Enter three **different** random 32-byte secrets during setup: `SETUP_SECRET`, `BETTER_AUTH_SECRET`, and `DATA_ENCRYPTION_KEY`. The deployment script builds the Vue assets, applies D1 migrations using the `DB` binding, and deploys the Worker. After deployment, open the Worker URL, enter the setup secret, claim the single owner account, and enroll administrator TOTP. Save the recovery codes shown during enrollment.

## Local development

Requires Node.js 20.19 or newer and npm. Run from the repository root:

```sh
npm install
cp .dev.vars.example .dev.vars
# Fill each blank secret in .dev.vars with a distinct `openssl rand -hex 32` value.
npm run db:migrate:local
npm run build
npm run dev
```

Open the local URL printed by Wrangler. The setup secret is needed only for the first owner claim. `npm test`, `npm run typecheck`, and `npm run lint` run the project checks. `npm run deploy` builds assets, applies remote D1 migrations, then deploys; it requires a configured Cloudflare account and should be run only when you intend to publish.

On a fresh local D1 database, `npm run smoke` exercises owner claim, TOTP enrollment, schedule save, check-in reset, and asset serving against the running `wrangler dev` server. It claims a test owner, so use a fresh local database for each full smoke run.

## API and behavior

`/api/docs` lists the application and Better Auth OpenAPI schemas. The application schema is `/api/openapi.json`; Better Auth publishes `/api/auth/open-api/generate-schema`. The current public setup endpoint is `/api/setup`, and all switch administration uses the one owner's Better Auth session. Administrator changes require a TOTP proof from the past five minutes.

An accepted `POST /api/check-ins` changes the cycle, anchors every round deadline to the new check-in time, and cancels pending old-cycle work. Check-ins can require an owner session, a separate check-in TOTP, a scoped API key, or a key plus TOTP. API keys have only `check-in:create` permission and never create administrator sessions. Their values appear only once when issued. Rounds have ordered or concurrent groups, and actions support `continue`, `stop_group`, or `stop_round` on failure. A manual-rearm round remains disarmed across new cycles until rearmed; later rounds retain their scheduled dates.

The code lives in `apps/backend` and `apps/web`, but Cloudflare deploys a single Worker. D1 migrations are in `apps/backend/migrations`. No production action executor is wired; unexpected queued jobs are marked for review without making an outbound call.

## Project status

The foundation implementation follows the [design spec](docs/superpowers/specs/2026-09-27-switch-foundation-design.md) and [implementation plan](docs/superpowers/plans/2026-09-28-switch-foundation.md). Delivery adapters, full guided action editor and templates, and native iOS app remain in the next release slices.
