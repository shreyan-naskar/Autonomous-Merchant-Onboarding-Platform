# Build Progress

Running log for the Autonomous Merchant Onboarding Platform. Read with
[PLAN.md](PLAN.md) (scope, phases, "Done when", cut list) and
[PROBLEM.md](PROBLEM.md) (brief). A fresh session should be able to resume
from these two files alone.

## Status at a glance

| Phase | Status | Notes |
|---|---|---|
| 0. Setup | DONE | deps, Vitest, config, error handler, masking |
| 1. Domain model + state machine | DONE | schema, migration, transition() + guards, walk script |
| 2. Intake API | NEXT | |
| 3. Worker + extraction | todo | |
| 4. Mock providers + callbacks | todo | |
| 5. Approval, MID, bank change | todo | |
| 6. UI | todo | |
| 7. Stretch | todo | cut first if behind |
| 8. Hardening, docs, demo | todo | |

## Standing decisions (resolved plan gaps — follow these)

These come from the kickoff prompt and override or refine PLAN.md:

1. **Duplicate callbacks**: `callback_events` has its own `id` PK + `is_duplicate`
   boolean, with a partial unique index on `event_id WHERE is_duplicate = 0`.
   First insert is normal; on conflict insert a row with `is_duplicate = 1`,
   respond 200, take no other action, log "duplicate ignored".
2. **Risk**: a risk callback with a score is a PASSED verification (score stored).
   Score > 70 does not fail it; the approve step routes VERIFIED -> IN_REVIEW
   (reason `HIGH_RISK`). Score <= 70 auto-approves.
3. **Auto-approve**: when `evaluate()` moves an app to VERIFIED, enqueue an `approve` job.
4. **Approval guard in `transition()`**: any move to APPROVED (from VERIFIED or
   IN_REVIEW) requires PAN, GST, BANK, RISK all PASSED, with the BANK verification
   matching the current `bank_version`. Throws `GuardError` -> HTTP 409.
5. **Bank change**:
   - From VERIFIED: bump `bank_version`, mark old BANK verification superseded,
     VERIFIED -> IN_REVIEW (audit `BANK_CHANGED`, review task `BANK_CHANGED`),
     then IN_REVIEW -> VERIFYING and re-run BANK only. `evaluate()` returns it to VERIFIED.
   - In VERIFYING or IN_REVIEW: bump version and re-run BANK.
   - APPROVED or later: 409.
   - A callback for an older `bank_version` is recorded and audited but ignored for evaluation.
6. **evaluate()** only transitions out of VERIFYING. Callbacks arriving in
   IN_REVIEW update verification rows + audit log but do not change status.
7. **Masking**: `mask()` in `@app/shared`, last 4 chars only. Pino redact covers
   `pan`, `bank_account` and nested payloads. A test must serialize a full
   `GET /applications/:id` response and assert no raw PAN/account appears.

## Testability rules

- Worker exposes `runDueJobsOnce(now)`; `setInterval` only wraps it. No sleeps in tests.
- Inject a clock (`now()`) and a provider-client interface; state machine /
  evaluate / timeout logic is tested without port 4000. A small set of
  integration tests start the mock provider app in-process on a random port
  (`createMockApp().listen(0)`).
- `transition()` is the only writer of `applications.status`. Before each commit:
  `grep -rn "status" api/src --include=*.ts | grep -iE "update|set\(" ` and check
  that only `transition()` writes it.

## Repo facts

- npm workspaces: `api` (Express 5, :3000), `mock-providers` (Express 5, :4000),
  `web` (Vite + React 19 + Tailwind v4, :5173), `shared` (`@app/shared`, Zod v4).
  All ESM; relative imports use `.js` extensions (NodeNext).
- `npm test` at root = `vitest run` with one project per workspace
  (root `vitest.config.ts` -> `<ws>/vitest.config.ts`).
- `npm run dev` runs all three via concurrently. Entrypoints load the repo-root
  `.env` with `process.loadEnvFile`; tests never import entrypoints.
- `api/src/app.ts` exports `createApp({config, logger, mount?})`;
  `mock-providers/src/app.ts` exports `createMockApp()`.
- Config: `api/src/config.ts` `loadConfig(env)` (pure). Canonical names
  `PORT, DB_PATH, WEBHOOK_URL, MOCK_PROVIDER_URL, HMAC_SECRET, DEMO_MODE,
  CONFIDENCE_THRESHOLD, RISK_THRESHOLD, LOG_LEVEL`. Aliases for the original
  `.env`: `API_PORT`, `PROVIDER_BASE_URL`, `WEBHOOK_SECRET`.
  DEMO_MODE (default true): verification timeout 30s, backoff base 1s
  (non-demo: 15 min / 60s). Thresholds: confidence 0.8, risk 70.
- DB: `api/src/db/schema.ts` (Drizzle), migrations in `api/drizzle/`
  (`npm run db:generate -w api` after schema edits, `npm run db:migrate -w api`
  applies to DB_PATH). `openDb(path)` in `api/src/db/client.ts` migrates on open;
  tests use `openDb(':memory:')`. Timestamps are epoch ms integers from an
  injected `now`; booleans are 0/1; JSON columns are text (`mode: 'json'`).
- Domain vocabulary (statuses, `ALLOWED_TRANSITIONS`, `canTransition`, actors,
  `AUDIT_EVENTS`, verification kinds, `REQUIRED_CHECKS`) lives in
  `shared/src/domain.ts` so web can use it. New audit event names go there.
- `transition(db, appId, to, {actor, event, detail?, now?})` in
  `api/src/domain/transition.ts` (db is passed explicitly, not a module global).
  Guards keyed by target state in `api/src/domain/guards.ts`.
  `createApplication(db, input, {now, id})` in `api/src/domain/applications.ts`
  is the only other place a status is set (the initial SUBMITTED + audit row).
- Errors: `api/src/errors.ts` (`AppError`, `NotFoundError`, `BadRequestError`,
  `ConflictError`, `IllegalTransitionError`, `GuardError`). Central handler in
  `api/src/http/errorHandler.ts`.
- better-sqlite3 13.2 builds/loads on this Fedora machine with no extra system
  packages. npm 11 gates install scripts: `allowScripts` in root package.json
  approves better-sqlite3 and esbuild.

## Deviations from PLAN.md

- Plan docs live at `docs/PLAN.md` / `docs/PROBLEM.md` (copied from the
  root `plan.md` / `problem-statement.txt`, which stay gitignored).
- `callback_events` schema differs (see decision 1).
- Root `vitest` also runs a `web` project (no tests yet, `passWithNoTests`).
- `transition()` takes `db` as its first argument (plan signature omits it).
- The APPROVED guard (decision 4) is implemented in Phase 1, not stubbed:
  for each of PAN/GST/BANK/RISK the latest non-superseded attempt must be
  PASSED, and BANK must match the current `bank_version`. Phase 5 only needs
  to bump `bank_version` / set `superseded` on bank change.
- Extra columns: `documents.payload` (JSON body of structured docs),
  `verifications.score` (risk score), `review_tasks.note`,
  `jobs.created_at/updated_at`. `audit_log.from_state` is null for the creation
  row; `to_state` may be null for non-transition events (LATE_CALLBACK etc.).
- `callback_events.application_id` is not a foreign key (unknown refs are
  still recorded).

## Log

### Phase 0: Setup — DONE (2026-11-20)

Done:
- Installed: api (better-sqlite3, drizzle-orm, drizzle-kit, pino, pino-pretty,
  zod, multer, supertest), mock-providers (zod, supertest), web
  (@tanstack/react-query, tailwindcss, @tailwindcss/vite), vitest everywhere.
- Vitest workspace projects; root `npm test` runs all.
- `loadConfig()` with Zod v4 (`z.url()`, `z.stringbool()`, `z.coerce`).
- `mask()` / `redactText()` in shared.
- Pino logger with redaction (paths up to depth 5, censor = `mask()`), message
  scrubbing hook, allowlisted `err` serializer.
- Central error handler (Express 5 native async propagation).
- Mock provider app factory; placeholder `GET /api/pan/verify` removed.
- Tailwind v4 wired into web; `npm run build -w web` passes.

Bug found by tests: body-parser's `SyntaxError` carries the raw request `body`
as a property, so pino's default err serializer logged a raw PAN on malformed
JSON. Fixed by allowlisting err fields.

Test results (`npm test`):
```
 Test Files  5 passed (5)
      Tests  20 passed (20)
```
Checks: `curl :3000/health` -> `{"status":"ok","service":"api"}`; malformed JSON
containing a PAN -> `400 Malformed JSON body`, log line contains no raw PAN.
`tsc --noEmit` clean for api, shared, mock-providers.

Local-only change: `.env` `WEBHOOK_URL` updated from `/webhooks` to
`/webhooks/provider` to match PLAN Phase 4.

### Phase 1: Domain model and state machine — DONE (2026-11-20)

Done (commits 1.1-1.4):
- Shared domain enums + `ALLOWED_TRANSITIONS` (17 edges) with shape tests
  (all states present, no self-loops, only MERCHANT_CREATED/REJECTED terminal,
  everything reachable from SUBMITTED).
- Drizzle schema for 8 tables + `0000_init.sql`; partial unique index
  `callback_events_event_id_uq ON (event_id) WHERE is_duplicate = 0` tested.
- `transition()`: one IMMEDIATE transaction; map check, guard, compare-and-set
  update (`WHERE id = ? AND status = from`), audit insert.
- Tests written first (red on missing modules, then green): all 17 legal edges,
  all 83 illegal edges with DB snapshot unchanged (11 named), APPROVED guard
  (no checks, one failed, newer attempt pending, stale bank_version,
  superseded), rollback when audit insert fails (SQLite trigger), creation
  audit row, contiguous full-walk trail. Mutation-checked: disabling the map
  check fails 13 tests, dropping the audit insert fails 19.
- `scripts/walk.ts` (in-memory DB unless `WALK_DB` set): walks SUBMITTED ->
  MERCHANT_CREATED, shows the guard blocking APPROVED before checks pass,
  prints a 6-row audit table.

Test results (`npm test`):
```
 Test Files  8 passed (8)
      Tests  71 passed (71)
```
Checks: `npm run db:migrate -w api` creates all 8 tables in `api/data/app.db`
(re-run is a no-op); `npx tsx scripts/walk.ts` prints the full trail;
`tsc --noEmit` clean for api and shared; status-writer grep shows only
`transition.ts`.

Next: Phase 2 — intake API (`POST/GET/PATCH /applications`), wire `openDb`
into `createApp`, sample payloads in `/sample-data`.
