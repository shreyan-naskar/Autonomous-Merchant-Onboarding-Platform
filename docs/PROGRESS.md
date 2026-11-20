# Build Progress

Running log for the Autonomous Merchant Onboarding Platform. Read with
[PLAN.md](PLAN.md) (scope, phases, "Done when", cut list) and
[PROBLEM.md](PROBLEM.md) (brief). A fresh session should be able to resume
from these two files alone.

## Status at a glance

| Phase | Status | Notes |
|---|---|---|
| 0. Setup | DONE | deps, Vitest, config, error handler, masking |
| 1. Domain model + state machine | NEXT | |
| 2. Intake API | todo | |
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

Next: Phase 1 — Drizzle schema + migration, `transition()` with
ALLOWED_TRANSITIONS and audit row in one DB transaction, tests first.
