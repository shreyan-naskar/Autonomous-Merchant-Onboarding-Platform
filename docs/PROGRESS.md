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
| 2. Intake API | DONE | POST/GET/PATCH /applications, masking layer, sample-data |
| 3. Worker + extraction | DONE | worker, validators, extract job, decision, NEEDS_INFO re-entry |
| 4. Mock providers + callbacks | DONE | signed async callbacks, idempotent webhook, evaluate, timeouts/retries, late reconciliation |
| 5. Approval, MID, bank change | DONE | approve job, review endpoint, create_merchant + MID service, bank change |
| 6. UI | DONE | all six pages; demo script verified through the Vite proxy, not clicked in a browser |
| 7. Stretch | DONE | all four: blur + OCR, duplicates, dead-letter view, PDF text |
| 8. Hardening, docs, demo | DONE | scenario + security tests, `npm run demo`, README, DEMO.md, tag v1.0 |

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
- Intake (Phase 2): wire format is snake_case JSON. Request schemas in
  `shared/src/intake.ts` (format regexes `PAN_RE`, `GSTIN_RE`, `IFSC_RE`,
  `BANK_ACCOUNT_RE` live there for Phase 3 to reuse); DTO schemas in
  `shared/src/dto.ts` (timestamps ISO strings). `submitApplication()` in
  `api/src/domain/applications.ts` writes app + audit + documents + `extract`
  job (payload `{application_id}`) in one transaction. `enqueueJob(dbOrTx,
  type, payload, opts)` in `api/src/jobs/queue.ts`; job types in shared
  `JOB_TYPES`. Read queries in `api/src/domain/queries.ts`.
- Masking: `api/src/http/dto.ts` is the only response mapper. Use it for any
  new application-related response. `SENSITIVE_KEYS` (shared) drives both
  the mapper (`maskDeep`) and pino redaction; it includes `gst`/`gstin`
  because a GSTIN embeds the PAN. Extracted field names `pan`, `gst`,
  `bank_account` are masked by name, so Phase 3 should use those names.
- `createApp({config, logger, db, now?})`. Uploads go to `UPLOAD_DIR`
  (default `./uploads`, i.e. `api/uploads/` under npm workspaces, gitignored),
  random file names; DTOs show only `file_name`, never the server path.
- Errors: `api/src/errors.ts` (`AppError`, `NotFoundError`, `BadRequestError`,
  `ConflictError`, `IllegalTransitionError`, `GuardError`). Central handler in
  `api/src/http/error-handler.ts`.
- Worker (Phase 3): `api/src/jobs/worker.ts`. `runDueJobsOnce(deps, now)`
  claims with one `UPDATE jobs SET status='running', attempts=attempts+1
  WHERE status='queued' AND id IN (due) RETURNING`, so `attempts` counts the
  try at claim time. Handler signature `(payload, {db, config, logger, now,
  job})`; throw to fail. Retry delay `backoffBaseMs * 2^(attempts-1)`; at
  `max_attempts` -> `dead` + review task `JOB_DEAD` + audit `JOB_DEAD`; each
  retryable failure writes audit `JOB_FAILED` (to_state null). Unknown job
  type -> dead immediately. Errors are `redactText()`ed before storage.
  `startWorker(deps, {now, intervalMs})` wraps it in a non-overlapping
  `setInterval`; started from `api/src/index.ts`. Registry:
  `createJobHandlers()` in `api/src/jobs/handlers.ts` (Phase 4 replaces the
  `start_verifications` stub there). In tests, drive with a `drain()` loop
  over `runDueJobsOnce` (see `api/src/extraction/flow.test.ts`).
- `transition(db | tx, ...)`: pass a transaction to make the move atomic with
  other writes (drizzle runs it as a savepoint).
- Validators: `shared/src/validators.ts` (`isValidPan/Gstin/Ifsc/BankAccount`,
  `gstinMatchesPan`, `normalizeName`, `nameSimilarity` = max(token Jaccard,
  Levenshtein ratio) over normalized names, `namesMatch`). Config
  `NAME_MATCH_THRESHOLD` (default 0.85) -> `config.thresholds.nameMatch`.
- Extraction: `api/src/extraction/extract.ts` (pure `extractFields`),
  `decide.ts` (pure `decideAfterExtraction`), `job.ts` (`runExtraction`, the
  DB side). Field names: PAN_CARD -> `pan`, `name`; GST_CERT -> `gst`,
  `legal_name`; BANK_PROOF -> `bank_account`, `ifsc`, `account_holder`.
  Per-field rule (first wins): absent -> `missing` (0); upload without
  payload -> `low_confidence` (0, `unreadable`); bad format ->
  `low_confidence` (0.5); differs from form / GSTIN not embedding PAN / name
  similarity < threshold -> `mismatch` (1.0); else `ok` (1.0). Required:
  all three documents and form `pan`, `gst`, `bank_account`, `ifsc`.
  Missing-list labels: `form.<field>`, `document.<TYPE>`, `<TYPE>.<payload key>`.
  Decision order: missing -> NEEDS_INFO (`INFO_REQUIRED`), mismatch ->
  IN_REVIEW `DOC_CONFLICT`, confidence < threshold -> IN_REVIEW
  `LOW_CONFIDENCE`, else VERIFYING (`VERIFICATION_STARTED`) + enqueue
  `start_verifications`. Fields + transition + review task + next job are one
  transaction; SUBMITTED -> EXTRACTING commits first so a retry resumes from
  EXTRACTING. Extract jobs for apps in any other state are no-ops.
- Mock providers (Phase 4): `createMockApp({webhookUrl, hmacSecret, chaos?,
  scheduler?, fetch?, onDelivery?})` in `mock-providers/src/app.ts`, exported
  as package `mock-providers` (api devDependency) so API tests can start it.
  `POST /pan/verify|/gst/verify|/bank/verify|/risk/score` -> `202
  {request_id}`, then a callback `{event_id, request_id, kind, result:{status,
  reason?, score?}, application_ref, bank_version?}` with `X-Signature` = hex
  HMAC-SHA256 of the raw body. `GET/POST /admin/config` (global chaos:
  `delayMs`, `failKinds`, `duplicateCallback`, `dropCallback`,
  `lateCallbackMs`), `POST /admin/reset`. Settings are read per request.
  Magic values: PAN `ZZZZZ9999Z` fails, GSTIN ending `Z9` fails, account
  ending `0000` never calls back, name containing `RISKY` scores 85 (others
  0-40, deterministic). Wire schemas (`ProviderCallbackSchema`,
  `ChaosConfigSchema`, `PROVIDER_PATHS`, `MAGIC`) live in `shared/src/providers.ts`.
  `createManualScheduler()` gives tests virtual time: `sched.advance(ms)`
  sends and awaits every due callback.
- Provider client: `ProviderClient` interface in `api/src/providers/client.ts`
  (`createHttpProviderClient({baseUrl})`, `buildProviderRequest(kind, app)`);
  `createFakeProviderClient()` in `fake.ts` records calls, never calls back,
  `fake.failing.add(kind)` simulates an outage. `createJobHandlers({providers})`
  now takes the client.
- Verification code is in `api/src/verification/`:
  - `latest.ts` `currentVerification(db, app, kind)`: newest non-superseded
    row (BANK: current bank_version). evaluate(), the APPROVED guard and
    start_verifications all use it.
  - `start.ts` `start_verifications` job, payload `{application_id, kinds?}`
    (default all four). A kind is requested when it has no current row or
    the current row is TIMED_OUT (-> attempt + 1); a PENDING row without
    request_id (failed earlier run) is reused; anything else is skipped. Only
    acts in VERIFYING. Provider calls happen outside transactions; each
    accepted request stores request_id + enqueues `verification_timeout`
    (`{application_id, verification_id}`, +30s demo) + audits
    `VERIFICATION_REQUESTED` in one transaction. Any failed call throws after
    the rest are recorded (worker retries).
  - `callback.ts` `receiveCallback` (webhook) and `applyCallback`. Outcomes:
    `applied`, `late`, `stale`, `already_completed`, `mismatch`,
    `unknown_request` (stored in `callback_events.note`; `processed` is false
    only for unknown_request and duplicates). A real result supersedes newer
    PENDING/TIMED_OUT attempts of the same kind. Audit events (actor
    `provider`, to_state null): `VERIFICATION_RESULT`, `LATE_CALLBACK`,
    `STALE_CALLBACK`. `applyEarlyCallbacks` applies a callback that arrived
    before its request_id was stored.
  - `evaluate.ts` pure `decideVerification`/`failureReason` + `evaluate(tx,
    appId, now)`. Reason = checks in PAN, GST, BANK, RISK order up to the last
    FAILED one, each `<KIND>_<OK|FAILED|PENDING|TIMED_OUT>`.
    VERIFIED: event `ALL_CHECKS_PASSED` + `approve` job (stub handler).
    IN_REVIEW: event `VERIFICATION_FAILED` + review task (reason as above,
    note lists every check with provider reason/score).
  - `timeout.ts` `verification_timeout` job: PENDING -> TIMED_OUT; if
    `attempt <= verificationMaxRetries` (2) enqueue `start_verifications
    {kinds:[kind]}` at `now + backoffBase * 2^(attempt-1)`; else IN_REVIEW
    (event `VERIFICATION_TIMED_OUT`, review task `<KIND>_TIMEOUT`). Outside
    VERIFYING it only marks TIMED_OUT.
- Webhook: `api/src/http/routes/webhooks.ts`, mounted before
  `express.json` in `createApp` (raw body for HMAC). `verifySignature` in
  `api/src/http/signature.ts` (timingSafeEqual, accepts `sha256=` prefix).
  401 on a bad or missing signature, 400 on invalid JSON or schema, and
  nothing is stored in either case. 200 `{status: accepted|duplicate,
  event_id, outcome?}`.
- New audit event `VERIFICATION_REQUESTED`. Migration `0001` adds
  `callback_events.request_id` (+ index).
- Test helpers: `api/src/verification/testkit.ts` (in-memory env,
  `verifyingApp()`, row getters). End-to-end: `api/src/verification/flow.test.ts`
  (API + mock on random ports, `advance(ms)` runs jobs at their run_at).
- Approval (Phase 5): `approve` job = `runApprove` in `api/src/approval/approve.ts`
  (VERIFIED only; RISK `score <= RISK_THRESHOLD` -> APPROVED `AUTO_APPROVED`,
  else / null score -> IN_REVIEW `HIGH_RISK` + task `HIGH_RISK`). Every move into
  APPROVED calls `enqueueCreateMerchant(tx, ...)` (max_attempts =
  `config.limits.merchantCreateMaxAttempts` = 3).
- Merchant IDs: `api/src/merchant/service.ts` `MerchantService` interface +
  `createSimulatedMerchantService(db, {fail?, generate?})`. Ledger table
  `merchant_accounts` (MID PK, `application_id` UNIQUE = idempotency key), plus a
  unique index on `applications.merchant_id`. `svc.fail` is the runtime flag;
  `index.ts` passes ONE instance to both `createApp({merchantService})` and
  `createJobHandlers({merchantService})`. `create_merchant` = `runCreateMerchant`
  in `merchant/create.ts`: APPROVED only; reuses `applications.merchant_id` if
  set; on failure throws while attempts remain (worker backoff, audit
  `JOB_FAILED`), on the last attempt -> MERCHANT_CREATION_FAILED + task
  `MERCHANT_CREATION_FAILED` and the job completes (no JOB_DEAD).
- Review: `POST /applications/:id/review {taskId, resolution, note}` ->
  `resolveReview` in `api/src/review/resolve.ts`, schemas in
  `shared/src/review.ts`. Resolutions and the states they are allowed from:
  APPROVE (VERIFIED, IN_REVIEW), REJECT / REQUEST_INFO / RETRY_VERIFICATION
  (IN_REVIEW), RETRY_MERCHANT_CREATION (MERCHANT_CREATION_FAILED). Wrong state ->
  409 `ILLEGAL_TRANSITION` "X is not possible while the application is S";
  guard -> 409 `GUARD_FAILED` with per-check message; resolved task -> 409;
  task of another app -> 404. Note is `redactText`ed, stored in
  `review_tasks.resolution_note` and the transition's audit detail
  `{task_id, task_reason, resolution, note}`. RETRY_VERIFICATION supersedes the
  current rows of the non-PASSED kinds (all four if all passed) and enqueues
  `start_verifications {kinds}`.
- `POST /admin/merchant-service {fail: boolean}` / `GET` (api, no auth, demo only).
- Bank change: `applyBankChange` in `domain/applications.ts`, triggered by a
  `bank_account`/`ifsc` change in VERIFYING, VERIFIED or IN_REVIEW (decision 5).
  Enqueues `start_verifications {kinds:['BANK'], bank_version}`; a payload with
  `bank_version` may run in IN_REVIEW and is skipped if the version moved on.
  VERIFIED path: IN_REVIEW (merchant `BANK_CHANGED`, task `BANK_CHANGED`) ->
  VERIFYING (system `BANK_REVERIFICATION_STARTED`). When evaluate() reaches
  VERIFIED it auto-resolves open `BANK_CHANGED` tasks (resolution
  `AUTO_REVERIFIED`, audit `REVIEW_TASK_AUTO_RESOLVED`) and the approve job
  auto-approves as usual.
- Migration `0002_phase5_merchant`. New audit events `BANK_REVERIFICATION_STARTED`,
  `REVIEW_TASK_AUTO_RESOLVED`. Sample `high-risk.json` (name contains RISKY).
- Testkit additions: `seedVerification`, `verifiedApp(db, id, {riskScore})`.
  Phase 5 end-to-end: `api/src/approval/flow.test.ts` (its `drain()` only runs
  jobs due within 5s so the 30s verification timeouts never fire).
- Web (Phase 6): `web/src` — `main.tsx` (QueryClient with `refetchInterval:
  3000` default, BrowserRouter), `App.tsx` (nav + routes + MetricsStrip),
  `lib/api.ts` (`api` -> `/api`, `mockApi` -> `/mock`; `ApiError` carries the
  API's message so 409s show inline), `pages/` (ApplicationList,
  ApplicationDetail, ReviewQueue, SubmitApplication, DemoPanel),
  `components/`. Vite proxy in `web/vite.config.ts`: `/api` -> :3000 and
  `/mock` -> :4000 with the prefix stripped (ports from `API_PORT` /
  `MOCK_PROVIDERS_PORT`), so no CORS. `server.fs.allow: ['..']` lets
  `import.meta.glob('../../../sample-data/*.json')` bundle the samples.
  The UI holds no workflow state: which review buttons appear comes from
  `REVIEW_RESOLUTION_FROM` (shared, also enforced by the API), the current
  verification row from the API's `is_current`.
- API additions for the UI (read-only): detail DTO `callbacks[]` (no
  payloads) and `verifications[].is_current`; `GET /review-tasks?status=OPEN|RESOLVED`
  (`listReviewTasks`, task + merchant name + app status, oldest first);
  `GET /metrics` (`api/src/metrics/metrics.ts`: pure `computeMetrics` over
  transition rows — avg of completed stays per state, `current` counts,
  exception rate = apps that ever entered IN_REVIEW or NEEDS_INFO / total).
- `web` ESLint is broken independently of this work (crashes inside
  `@typescript-eslint` with TypeScript ~6 on HEAD before Phase 6); `tsc -b` is
  the check that runs (`npm run typecheck`).
- better-sqlite3 13.2 builds/loads on this Fedora machine with no extra system
  packages. npm 11 gates install scripts: `allowScripts` in root package.json
  approves better-sqlite3 and esbuild.

- Document reading (Phase 7): `api/src/extraction/read.ts`
  `readUploadedDocuments(docs, {ocr, blurThreshold})` runs in the extract job
  before its transaction (never in a request). Uploads without a payload:
  `.png/.jpg/.jpeg` -> `blurScore()` (`blur.ts`: sharp greyscale, resize to
  <=1000px wide, 3x3 Laplacian convolve, variance); below
  `config.thresholds.blur` (`BLUR_THRESHOLD`, default 30) -> blurry, no OCR;
  else OCR via `OcrEngine` (`ocr.ts`, `createTesseractOcr({cacheDir})`, lazy
  worker, model in `OCR_CACHE_DIR` default `api/.ocr-cache/`, gitignored).
  `.pdf` -> `pdfText()` (`pdf.ts`, pdf-parse v2, first 5 pages). Text ->
  `parseDocumentText(type, text)` (`text.ts`: PAN/GSTIN/IFSC by pattern,
  names and account number by label) -> same payload keys as JSON docs.
  `extractFields` takes `doc.reading`: field confidence = reading confidence
  (OCR mean confidence, PDF 0.95); value not found in a file ->
  `low_confidence`/`unreadable` (not `missing`). Blurry -> fields
  `low_confidence`/`blurry` + `result.blurryDocuments`. Decision order:
  missing -> BLURRY_DOCUMENT -> DOC_CONFLICT -> LOW_CONFIDENCE.
  `documents.blur_score` is written in the extraction transaction. Corrupt
  image/PDF, missing file, no text layer -> unreadable (no retry); an OCR
  engine error throws (worker retry). `createJobHandlers({ocr})`; without
  it an image that passes the blur check fails the job. `index.ts` creates
  one engine and terminates it on shutdown.
- Test fixtures: `api/src/extraction/testkit.ts` (`fakeOcr`,
  `PAN_SHARP_OCR_TEXT`, `textPdf(lines)` hand-built PDF writer). The real
  tesseract test in `ocr.flow.test.ts` runs only when
  `api/.ocr-cache/eng.traineddata` exists or `OCR_E2E=1`.
- Sample files: `npx tsx scripts/generate-sample-images.mts` writes
  `pan-sharp.png` (blur ~990), `pan-blurry.png` (~1.7), `gst-cert.pdf`,
  `bank-proof.pdf` for `sample-data/ocr-pan.json` (Sunrise Traders,
  PAN AAFCS4321M). Deterministic output.
- Duplicates: `api/src/domain/duplicates.ts` `flagDuplicates(tx, app, now)`
  inside `submitApplication`'s transaction. Normalized (codes upper-case no
  whitespace, account digits only, applied in SQL to stored rows) PAN, GSTIN,
  or account + IFSC vs every other application (any status, rejected
  included) -> one `POSSIBLE_DUPLICATE` task per match (max 5) on the new
  app with `review_tasks.related_application_id` (migration `0003`), audit
  `POSSIBLE_DUPLICATE` (to_state null, detail `{related_application_id,
  matched_on}`) on both apps. PATCH does not re-check.
- `runApprove`: an open POSSIBLE_DUPLICATE task holds auto-approval
  (VERIFIED -> IN_REVIEW, event `POSSIBLE_DUPLICATE`, no new task); high
  risk still adds its HIGH_RISK task. Resolution `DISMISS` (shared
  `INFORMATIONAL_TASK_REASONS`, any state but IN_REVIEW, no transition,
  audit `REVIEW_TASK_DISMISSED`; other reasons -> 409 `NOT_DISMISSIBLE`).
  `resolutionsFor(status, taskReason)` (shared) drives the UI buttons;
  `ReviewActions` takes `taskReason`.
- Dead letters: `api/src/jobs/dead-letter.ts` (`listDeadJobs`, `requeueJob`),
  routes `api/src/http/routes/jobs.ts`: `GET /jobs?status=dead` (only
  `dead` accepted), `POST /jobs/:id/requeue` (dead -> queued, attempts 0,
  run_at now; 409 not dead, 404, 400). Audit `JOB_REQUEUED` (operator) and
  the job's JOB_DEAD task resolved `REQUEUED` (matched by the worker's note
  prefix `Job <type> #<id> failed`). `toDeadJobDto` in `http/dto.ts` masks
  the payload. Web `/dead-letters` page (`pages/dead-letters.tsx`); review
  tasks show `TaskLinks` (related app / dead-letter link).
- New audit events: `BLURRY_DOCUMENT`, `POSSIBLE_DUPLICATE`,
  `REVIEW_TASK_DISMISSED`, `JOB_REQUEUED`.
- Phase 8: `api/src/e2e.ts` `startE2E({logStream?, logLevel?})` is the
  shared end-to-end harness (API + mock on random ports, fake clock,
  `drain(horizon)`, `deliver(ms)`, `submit/detail/review`). Brief scenarios:
  `api/src/scenarios.test.ts`; security checks: `api/src/security.test.ts`.
- `npm run demo` = `scripts/demo.ts` (CJS via tsx: no top-level await).
  Spawns `tsx src/index.ts` in api/ and mock-providers/ with
  `DB_PATH=api/data/demo.db` (deleted first, LOG_LEVEL=debug, logs in
  `api/data/demo-*.log`), or with both services already up resets them via
  `POST /admin/reset-data` (API, DEMO_MODE only) + mock `/admin/reset`.
  Duplicate via mock `POST /admin/redeliver {event_id?}`. Flags
  `--external` / `--spawn` (`npm run demo -- --external`).
- `OperatorNoteSchema` (shared) is the one note rule; `POST
  /jobs/:id/requeue` takes `{note}`.
- `.env.example` documents every setting; no `.env` is needed (API and
  mock share the default dev HMAC secret).

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
- Phase 2: form fields (pan, gst, bank_account, ifsc) are format-checked at
  intake (400); document payload values are only length-checked, so
  extraction (Phase 3) is what flags bad document values. Only
  `merchant_name` is required; one document per type.
- PATCH accepts form fields only (no documents yet). Supplying a missing
  document for NEEDS_INFO needs a PATCH/POST documents route in Phase 3/5.
  PATCH writes audit `APPLICATION_UPDATED` (new event; from_state = current,
  to_state null) and returns 409 in APPROVED, MERCHANT_*, REJECTED. It does
  not bump `bank_version` yet (Phase 5).

- Phase 3: PATCH also accepts structured `documents` (replace-by-type),
  only in NEEDS_INFO (409 elsewhere). In NEEDS_INFO any real change is one
  transaction: fields/docs + NEEDS_INFO -> EXTRACTING (actor merchant, event
  `INFO_SUPPLIED`, detail `{fields, documents}`) + new `extract` job; no
  separate APPLICATION_UPDATED row. A no-op PATCH does not move the app.
- Phase 4: callback processing runs **in the webhook's transaction** (no
  `process_callback` job). Inserting the event and applying it commit
  together, so "stored" always means "applied". If applying throws, nothing
  is stored and the 500 makes the provider redeliver. The work is a few
  indexed SQLite writes, so the 200 is still fast.
- Phase 4: the mock never retries a failed callback delivery (API down ->
  that result is lost, the API times out and re-requests). Fine for the demo.
- Phase 4: the review reason is built when the first failure arrives. With
  real-time callbacks the order is usually request order (PAN, GST, ...), but
  if GST's failure beat PAN's pass the reason would read
  `PAN_PENDING_GST_FAILED`. The review task note lists every check.
- Phase 5: the operator retry is a fifth resolution `RETRY_MERCHANT_CREATION`
  (the four in the brief have no way out of MERCHANT_CREATION_FAILED).
- Phase 5: after a bank change from VERIFIED, approval is automatic again once
  BANK passes (the BANK_CHANGED task is informational and auto-resolved). While
  re-verifying the app is in VERIFYING, so operator APPROVE gets 409
  ILLEGAL_TRANSITION; the GuardError 409 shows up when the bank changes while
  IN_REVIEW (e.g. HIGH_RISK), because then the app stays IN_REVIEW.
- Phase 5: the bank change does not re-extract or re-compare the BANK_PROOF
  document; the new account is only verified by the bank provider. Changing
  `pan`/`gst` after verification is still a plain APPLICATION_UPDATED (no
  re-verification). Both are known gaps.
- Phase 5: the merchant failure flag is in memory (resets on API restart).
- `jobs.status = 'failed'` is unused: failed attempts go back to `queued`
  until they become `dead`.
- Known gap: a job left `running` by a process crash is never reclaimed.
  Add a reaper (running and `updated_at` older than N) if it matters.
- Phase 7: BLURRY_DOCUMENT goes to IN_REVIEW (as asked), after the missing
  check (an incomplete app still goes to NEEDS_INFO first). PATCH cannot
  replace an uploaded file yet, so "re-upload" means operator handling.
- Phase 7: OCR/PDF parsers cover all three document types (the plan only
  asked for PAN + name from the PAN card) because the PDF path needs them.
  Scanned PDFs (no text layer) are not rasterized for OCR.
- Phase 7: duplicates hold auto-approval (not in the plan, which only says
  "create a review task"); otherwise a duplicate would auto-approve to a MID
  before anyone looked at the task. Submission itself is never blocked.
- Phase 7: tesseract.js downloads its English model (~10 MB) on first use;
  an offline machine with no cache fails extract jobs for images that pass
  the blur check (retried, then dead-lettered, requeueable).

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

### Phase 2: Intake API — DONE (2026-11-20)

Done (commits 2.1-2.3):
- Shared Zod schemas: JSON create, multipart fields (documents as a JSON
  text part), PATCH, list query; response DTOs; `maskDeep()`.
- Routes: `POST /applications` (JSON or multipart via multer, 201 +
  Location), `GET /applications` (time in state, open review count,
  `?status=`, `?limit=`), `GET /applications/:id`, `PATCH /applications/:id`.
- Zod 400s carry path/code/fixed message only; multipart JSON parse errors
  never quote input; MulterError -> 400/413 `UPLOAD_REJECTED`.
- `sample-data/` with README of magic values.

Bug found by tests: Drizzle renders column refs unqualified in single-table
selects, so the correlated `open_review_count` subquery compared
`review_tasks.application_id` with `review_tasks.id` and always returned 0.
The subquery now uses explicit qualifiers. Watch for this in Phase 6 metrics.

Mutation checks: un-masking `pan` in the mapper fails 9 tests; dropping
`maskDeep` on audit detail fails 1.

Test results (`npm test`):
```
 Test Files  10 passed (10)
      Tests  104 passed (104)
```
Checks: `curl -X POST localhost:3000/applications -H 'content-type:
application/json' -d @sample-data/happy.json` -> 201; GET shows `pan
******234K`, `gst ***********K1Z5`, `bank_account **********7891`, masked
document payloads, one `APPLICATION_SUBMITTED` audit row. After posting all
four samples, neither the list response nor the server log contained a raw
PAN or account. Invalid PAN -> 400 without the value. `tsc --noEmit` clean
for api and shared; status-writer grep shows only `transition.ts`.

Next: Phase 3. Worker loop (`runDueJobsOnce(now)`), `extract` job mapping
document payloads to `extracted_fields` (use field names `pan`, `gst`,
`bank_account`, `name`, `ifsc`), validators (tests first), then the decision
step. Expected outcomes are listed in `sample-data/README.md`.

### Phase 3: Worker and extraction/validation — DONE (2026-11-20)

Done (commits 3.1-3.4):
- Validators in shared, tests first (red on missing module, then green).
- Worker: atomic claim, handler registry, exponential backoff, dead-letter
  with review task + audit, non-overlapping `startWorker`, graceful shutdown
  on SIGINT/SIGTERM. Tests use an injected clock: backoff schedule
  (1s/2s/4s, not due 1ms early), dead at max_attempts, recovery on retry,
  no-handler dead-letter, PAN masking in stored errors, fake-timer interval.
- `extract` job + pure decision; `start_verifications` stub handler.
- PATCH in NEEDS_INFO -> EXTRACTING -> re-extract.

Mutation checks: backoff exponent off by one fails 3 tests; `>` instead of
`>=` for dead fails 2; skipping the missing rule fails 7; not enqueueing
start_verifications fails 1; PATCH not re-enqueueing extract fails 3.

Test results (`npm test`):
```
 Test Files  14 passed (14)
      Tests  217 passed (217)
```
Checks: live server (PORT 3999, scratch DB) with all four samples:
happy -> VERIFYING, gst-fail -> VERIFYING, conflict -> IN_REVIEW
(`DOC_CONFLICT`, name similarity 0.318), missing -> NEEDS_INFO
(`missing: ["document.GST_CERT"]`); PATCHing the GST certificate moved it
EXTRACTING -> VERIFYING within one poll. Server log contained no raw PAN or
account. `npm run typecheck` clean; status-writer grep shows only
`transition.ts` (other hits are `jobs.status`).

Next: Phase 4. Mock provider endpoints + HMAC callbacks, real
`start_verifications` handler (replace the stub in `jobs/handlers.ts`),
`POST /webhooks/provider` with idempotent `callback_events`, `evaluate()`,
`verification_timeout` job.

### Phase 4: Mock providers and callbacks — DONE (2026-11-20)

Done (commits 4.1-4.7 + end-to-end tests):
- Mock providers with signed async callbacks, chaos config, magic values,
  injectable scheduler (13 tests, virtual time).
- `ProviderClient` interface, HTTP client, in-memory fake.
- `start_verifications` (idempotent, partial-failure safe), webhook with
  raw-body HMAC + duplicate rows, callback processing (late / stale / early /
  mismatched), `evaluate()`, `verification_timeout` with 2 retries and
  `<KIND>_TIMEOUT` escalation. `approve` job is a logging stub.
- End-to-end with the mock on a random port: happy -> VERIFIED; duplicate
  callbacks -> one effect + one is_duplicate row per event; gst-fail ->
  IN_REVIEW `PAN_OK_GST_FAILED`; all four callbacks late after timeout ->
  `LATE_CALLBACK` x4, retries superseded, VERIFIED; account `...0000` ->
  3 attempts (backoff 1s, 2s) -> IN_REVIEW `BANK_TIMEOUT`; forged signature
  and wrong-secret provider -> 401, nothing stored.

Mutation checks: signature always valid fails 5 tests; skipping the
duplicate check fails 3; late result not superseding the retry fails 2;
one retry too few fails 2; ignoring failures in evaluate fails 4.

Test results (`npm test`, three consecutive runs):
```
 Test Files  21 passed (21)
      Tests  286 passed (286)
```
Checks: live API (:3999, scratch DB) + mock (:4999), real timers.
happy.json -> VERIFIED (4 requests, 4 results); gst-fail.json -> IN_REVIEW
`PAN_OK_GST_FAILED`, the later result recorded with from_state IN_REVIEW;
with `duplicateCallback` on: 4 applied + 4 `duplicate ignored` rows, still
4 results; forged signature -> 401. Neither log contained a raw PAN or
account. `npm run typecheck` clean; status-writer grep shows only
`transition.ts` writing `applications.status`.

Next: Phase 5. Replace the `approve` stub in `jobs/handlers.ts` (risk score
is on the RISK row's `score`; > `RISK_THRESHOLD` -> IN_REVIEW `HIGH_RISK`).
For the bank change: bump `bank_version`, set `superseded` on the current
BANK row, then enqueue `start_verifications {kinds:['BANK']}`. Old-version
callbacks are already handled as `STALE_CALLBACK`. For operator re-verify
(IN_REVIEW -> VERIFYING), supersede the current rows of the kinds being
re-run first. Otherwise a TIMED_OUT attempt 3 is retried as attempt 4 and
escalates on its first timeout.


### Phase 5: Approval, merchant ID, bank change — DONE (2026-11-21)

Done (commits 5.1-5.4):
- Guard: already enforced since Phase 1; message now names each blocking check
  (`Cannot approve: GST is failed; BANK is pending for bank version 2. ...`).
  Matrix tests from VERIFIED and IN_REVIEW x {missing, failed, pending,
  timed out, old bank_version, superseded}.
- `approve` job, `create_merchant` job, simulated MID service with DB ledger,
  admin failure flag, review endpoint, bank change.
- End-to-end (mock in-process): happy -> MERCHANT_CREATED with `MID-XXXXXXXX`;
  forced failure -> JOB_FAILED x2 (backoff 1s, 2s) -> MERCHANT_CREATION_FAILED
  + task -> APPROVE refused 409 -> RETRY_MERCHANT_CREATION -> MERCHANT_CREATED;
  bank change after VERIFIED -> APPROVE 409 while re-verifying -> BANK v2
  passes -> task auto-resolved -> MERCHANT_CREATED; bank change in IN_REVIEW ->
  GUARD_FAILED 409 (not started, then pending) -> passes -> operator approve;
  old-version BANK callback STALE; high risk -> IN_REVIEW HIGH_RISK; review
  validation, 404/409s, REJECT, REQUEST_INFO, RETRY_VERIFICATION (GST only).

Bug found by tests: IN_REVIEW -> APPROVED is a legal edge, so
RETRY_MERCHANT_CREATION on a HIGH_RISK task approved the app. Each resolution
now has an explicit list of source states.

Mutation checks: `<` instead of `<=` for risk fails 1; service not idempotent
fails 2; no bank_version bump fails 3; no per-resolution source states fails
2; no MERCHANT_CREATION_FAILED on the last attempt fails 2.

Test results (`npm test`, three consecutive runs):
```
 Test Files  24 passed (24)
      Tests  333 passed (333)
```
Checks: live API (:3999, scratch DB) + mock (:4999), real timers.
happy.json -> MERCHANT_CREATED `MID-MZY6DMU5`; high-risk.json -> IN_REVIEW
HIGH_RISK; PATCH bank -> bank_version 2, APPROVE -> 409 `Cannot approve: BANK
is not started for bank version 2...`, then 200 after the callback; with
`/admin/merchant-service {fail:true}`: AUTO_APPROVED, JOB_FAILED x2,
MERCHANT_CREATION_FAILED; flag off + RETRY_MERCHANT_CREATION ->
MERCHANT_CREATED. No raw PAN/account in either log. `npm run typecheck` clean;
status-writer grep shows only `transition.ts` writing `applications.status`.

### Phase 6: Operator and merchant UI — DONE (2026-11-21)

Done (commits 6.1-6.6, one per page):
1. Application list: status badge (one color per state, typed against the
   shared enum), merchant, time in state, open reviews, MID, status filter;
   rows link to the detail.
2. Detail: header with masked PAN/GSTIN/account and MID; vertical timeline
   from audit_log (actor icon, from -> to, event, expandable masked detail);
   extracted fields with confidence bar and validation chip; 4 verification
   cards (status, attempt, bank version, risk score, late / duplicate ignored /
   stale markers, attempt history); missing-info panel (latest INFO_REQUIRED
   items, operator note, JSON documents PATCH) in NEEDS_INFO; review tasks
   with actions; merchant bank-change form.
3. Review queue: open tasks (reason, app link, status) with a required note
   and only the resolutions the API accepts in that state; errors including
   the 409 guard message are shown inline.
4. Submit: form fields, JSON documents textarea, "load sample" dropdown
   (all of sample-data/, bundled at build time), file upload per document
   type (multipart; an uploaded file replaces the JSON doc of that type).
5. Demo controls: switches for fail GST, duplicate callback, drop callback
   (timeout), late callback (45s), fail merchant creation; callback delay;
   reset all; current mock + merchant-service config shown.
6. Metrics strip on every page: total, exception rate, avg time per state.
   API tests for `computeMetrics` (3) and `GET /metrics` over HTTP (1);
   `GET /review-tasks` test.

Test results (`npm test`):
```
 Test Files  25 passed (25)
      Tests  338 passed (338)
```
`npm run typecheck` (api, shared, mock-providers, web) clean; `vite build` clean.

Verified (with `npm run dev`, scratch DB_PATH, everything through Vite on :5173):
- `npm run dev` starts api :3000, mock :4000, web :5173; `/`, `/review`,
  `/submit`, `/demo`, `/applications/:id` serve the SPA; every page module
  and the five sample JSON modules compile/serve (200).
- `/api/*` and `/mock/*` proxies reach both backends.
- Demo script, via the same requests the pages make
  (scratchpad `demo_check.py`): (1-3) happy.json with duplicate callbacks
  on -> SUBMITTED > EXTRACTING > VERIFYING > VERIFIED > APPROVED >
  MERCHANT_CREATED, MID shown, 8 callbacks / 4 duplicates, fields at
  confidence 1 `ok`, PAN masked; (4) gst-fail.json -> IN_REVIEW
  PAN_OK_GST_FAILED, short note -> 400 with "Note is required (at least 5
  characters)", REJECT -> REJECTED, queue empty; (5) high-risk.json ->
  IN_REVIEW HIGH_RISK, bank change -> bank_version 2, APPROVE -> 409 "Cannot
  approve: BANK is not started for bank version 2...", APPROVE after BANK v2
  passes -> APPROVED -> MERCHANT_CREATED; fail merchant creation ->
  JOB_FAILED x2 -> MERCHANT_CREATION_FAILED -> RETRY_MERCHANT_CREATION ->
  MERCHANT_CREATED; metrics: 4 apps, exception rate 0.5. No raw PAN/account in
  any response. Multipart upload through the proxy stores the file.

Not verified (needs a real browser; no browser tool in this session):
- Rendering, layout and styling of each page; clicking through the UI;
  3s polling visibly updating the timeline; the switches' toggled look;
  inline error boxes appearing on 409/400; file picker behavior. The code
  paths are typechecked and the API calls they make are verified above.

Demo notes:
- "Bank change on a verified application": happy apps auto-approve within a
  second, so in the browser use high-risk.json (stays IN_REVIEW) or set the
  callback delay to ~15000 ms in Demo controls first; then the 409 guard
  message is visible on Approve until the BANK v2 callback lands.
- Push from this session failed (no GitHub credentials in the shell); push
  manually.

### Phase 7: Stretch — DONE (2026-11-21)

Time check before starting: 24-hour plan, started 2026-11-20 21:10, about
3h elapsed at the end of Phase 6, so well ahead. All four items done, in
order (commits 7.1-7.4):
1. Blur + OCR: Laplacian-variance blur score (threshold 30, calibrated on
   generated `pan-sharp.png` 989.7 vs `pan-blurry.png` 1.7; Gaussian blur
   sigma 2 scores 49.6, sigma 3 12.7, where tesseract confidence drops to
   0.82). Below threshold -> IN_REVIEW `BLURRY_DOCUMENT`. tesseract.js reads
   PAN + name in the extract job; confidence = OCR confidence; existing
   conflict / low-confidence rules apply.
2. Duplicate detection at submit -> `POSSIBLE_DUPLICATE` task linking both
   apps; non-blocking; holds auto-approval; `DISMISS` resolution.
3. Dead-letter view: `GET /jobs?status=dead`, `POST /jobs/:id/requeue`,
   web page with Requeue button.
4. PDF text via pdf-parse into the same extractors (confidence 0.95).

Test results (`npm test`, with the tesseract model cached so the real-OCR
test ran):
```
 Test Files  31 passed (31)
      Tests  401 passed (401)
```
New tests: `blur.test.ts` (calibration, monotonic, resolution/JPEG,
blank, non-image), `text.test.ts`, `read.test.ts` (images + PDFs),
`extract.test.ts` OCR rules, `ocr.flow.test.ts` (HTTP upload -> worker:
OCR not in request, blurry, sharp, conflict, low confidence, OCR outage,
PDFs, scanned PDF, real tesseract), `duplicates.test.ts` (normalization,
each key, IFSC required, multiple/rejected matches, samples never collide,
DTO + queue, approve hold, DISMISS rules), `deadLetter.test.ts` (masking,
requeue, task resolution, retry budget, 409/404/400).
`npm run typecheck` clean; `vite build` clean.

Verified live (api + mock-providers via tsx, scratch DB, curl):
- ocr-pan form + `pan-sharp.png`: blur 989.71, real OCR fields at 0.94 ->
  MERCHANT_CREATED with MID.
- Same + `pan-blurry.png`: blur 1.68 -> IN_REVIEW, BLURRY_DOCUMENT task
  "PAN_CARD (blur score 1.68 < threshold 30)", plus POSSIBLE_DUPLICATE
  linking the first app.
- All three documents as files (PNG + 2 PDFs): PDF fields at 0.95 ->
  verification passes -> held in IN_REVIEW by two POSSIBLE_DUPLICATE tasks.
- Mock providers stopped, gst-fail.json submitted: start_verifications
  dead after 5 attempts, listed by `GET /jobs?status=dead`; mock restarted,
  requeue -> queued/attempts 0 (second requeue 409) -> verifications ran ->
  IN_REVIEW PAN_OK_GST_FAILED; JOB_DEAD task RESOLVED/REQUEUED.
- No raw PAN/account in the API log.

Not verified: the new UI (Dead letters page, Dismiss button, related-app
links) in a real browser; it typechecks and builds.

### Phase 8: Hardening, docs, demo — DONE (2026-11-21)

1. Tests: suite run 8 times (5 with `--sequence.shuffle`), no flakes; all
   timing is virtual. New `api/src/scenarios.test.ts`: SCENARIO 1-6b, one
   named end-to-end test per brief failure scenario (PAN ok/GST fail,
   duplicate callback, late callback, bank change after verification,
   merchant ID failure, DOC_CONFLICT, BLURRY_DOCUMENT), listed in the README
   with file paths.
2. Security pass, kept as `api/src/security.test.ts`: status written only
   by `transition()` (source scan; the other `update(applications)` calls set
   bank_version, merchant_id or whitelisted form fields); full flows at debug
   level with a PAN typed into an operator note: no raw PAN/GSTIN/account in
   logs or responses (mutation-checked: fails when masking is removed);
   webhook 401 for missing/wrong/tampered/malformed signatures with nothing
   stored; every resolution needs a note. Found and fixed: dead-letter
   requeue was an operator action without a note (now required, audited);
   a missing note gave Zod's generic message (now "Note is required").
3. `npm run demo` (see Repo facts): 14 checks plus both audit trails as
   tables and a log scan for raw values.
4. README rewritten (quick start, Mermaid diagrams, API summary, scenarios,
   assumptions, mocks, limitations, production path, data handling, all
   deviations). 5. `docs/DEMO.md` with a verified curl fallback per step.

Test results (`npm test`):
```
 Test Files  33 passed (33)
      Tests  424 passed (424)      # fresh clone: 423 passed, 1 skipped (real OCR, no cached model)
```
`npm run typecheck` clean.

Verified:
- `npm run demo` against `npm run dev` twice (second run reset 2 apps).
- Every DEMO.md curl fallback run against `npm run dev` (the 409 guard text
  matches the doc).
- Final: fresh `git clone` of HEAD (no .env, no node_modules, no OCR
  cache) -> `npm ci` -> `npm test` -> `npm run demo` twice: both exit 0,
  14/14 checks, 0 raw values in the API logs, ports released.

Not verified: the UI in a real browser (no browser tool in these sessions);
the click-by-click DEMO.md steps are built from the page code, and their API
calls were run via curl. Mermaid diagrams were not rendered locally.


### After v1.0: real documents, demo-in-the-website (2026-11-21)

1. Real documents (a bilingual PAN card JPEG, a two-column bank statement
   PDF) extracted badly. Fixed: per-field OCR confidence from word
   confidences (`OcrResult.words`, `valueConfidence`), labels after junk or
   separators (Father's / Mother's / Branch / ... Name excluded), `cleanName`
   (drop titles, keep the capitalized run), tab = column break, IFSC 5th
   char O -> 0, PDF rows rebuilt from item positions with pdfjs-dist
   (replaces pdf-parse, which cannot give positions). Image preprocessing
   was measured and made OCR worse on the real card, so none is applied.
2. A "merchant fixes problems first" routing was built and then removed at
   the user's request: the brief routes exceptions (blurred, conflicting,
   low-confidence documents) to a human reviewer. Kept from that work:
   NEEDS_INFO audit detail is `InfoRequestDetail` (`shared/src/correction.ts`:
   plain-language `requests` for missing items, `form_fields`, `documents`;
   built by `api/src/extraction/requests.ts`), multipart `PATCH
   /applications/:id` (files only in NEEDS_INFO, replaced uploads deleted),
   and the web `MissingInfoPanel` (an input per missing form field, an
   upload per missing document, "Other changes", operator Request info
   offers everything).
3. Demo in the website: `docs/REQUIREMENTS.md` (every line of the brief with
   how to show it). Mock chaos `outage` (503 for every verify request) with
   a **Provider outage** switch; **Delete all data** button
   (`/admin/reset-data`); samples `low-confidence.json`,
   `missing-gst-cert.pdf` (generator). Every walkthrough's outcome and
   timing was checked on live services (scratch DB, ports 3100/4100):
   outage dead-letters in ~17s and completes after requeue; late callback
   ~47s; dropped callback -> IN_REVIEW PAN_TIMEOUT ~94s; duplicate
   application held POSSIBLE_DUPLICATE; merchant ID failure; low
   confidence; conflict; blurry; missing + PDF upload -> MERCHANT_CREATED;
   restart mid-VERIFYING completes 28s after restart.

Tests: 458 passing. The website pages were typechecked and built, not
clicked in a browser (no browser tool).

### UI polish pass (2026-11-21)

Visual direction "Ledger": paper-white surfaces, slate ink, one deep teal
accent; Inter (bundled) with tabular numerals, monospace for IDs and masked
values; status always as tone + icon + words.

1. Design foundation: `@theme` tokens in `web/src/index.css` (accent,
   success / warning / danger / info / neutral, radius, shadows, motion,
   focus rings, reduced motion); primitives in `components/ui.tsx` (Button,
   Input / Textarea / Select with label + hint + error, Switch, Card, Badge,
   Alert, StatCard, Tabs, Dialog with focus trap, Tooltip, Skeleton,
   EmptyState, CopyButton, PageHeader); toasts (`components/toast.tsx`,
   `emitToast` for code outside React); lucide-react icons.
2. Shell (`components/app-shell.tsx`): grouped sidebar with open-task and
   dead-letter badges, collapsible / mobile drawer; top bar with title,
   global search (`/`), API health dot; banners (offline, active demo
   failure mode). Metrics as stat cards on Applications only. Breadcrumbs +
   document.title via `PageHeader` / `lib/page-title.tsx`.
3. Plain language: `shared/src/labels.ts` (states, review reasons incl. all
   97 generated codes, events, checks, actors, resolutions);
   `api/src/labels.test.ts` proves the API only creates listed reasons, and
   `web/src/lib/labels.test.tsx` that each has a label. Pages rebuilt:
   Applications (chips, needs-attention, search, sort, relative times),
   application page (next action, stepper with exception branch, tabs,
   status-change toast + flash), Review queue (cards, confirm dialogs with
   required note and friendly 409), Submit (3 steps, sample cards, inline
   validation, drag-and-drop with previews), Demo controls, Dead letters.
4. Errors: NotFound (catch-all and missing / malformed application id),
   ErrorBoundary, PageError (5xx full page with Retry), OfflineBanner;
   `lib/query-client.ts` (no 4xx retries, mutation errors toast, query
   errors never toast); `lib/api.ts` (`ApiError.kind`, `fieldErrors`,
   `friendlyError`). API: 404 message redacted; Supertest cases for JSON
   404 and no PAN / account in errors. Found and fixed a real leak: the
   request logger, error handler and webhook rejection log wrote raw URL
   paths (a PAN in a URL reached the logs).
5. Verify: web component tests (Vitest + jsdom + Testing Library; jsdom is
   a root devDependency because vitest is hoisted): unknown route ->
   NotFound, mocked 404 -> NotFound, malformed id, error boundary + Retry,
   5xx / network PageError, label coverage, dialog keyboard behaviour,
   field ARIA wiring, central error helpers. Root `npm run build`.

Results: `npm test` 577 passed (40 files); `npm run build` and
`npm run typecheck` clean. Browser checks (headless Chrome via
playwright-core, scripts outside the repo, on a scratch stack: API 3100,
mocks 4100, Vite 5174, scratch DB): every page screenshotted and reviewed at
1366 px and 390 px (no horizontal scroll after fixing hidden tooltips that
widened the page); offline banner appears when the API is stopped and clears
when it is back; the whole of docs/DEMO.md (17 steps, incl. the guard 409
dialog and the bank re-verification) passes end to end with no page or
console errors. Not verified: screen readers, real mobile devices, contrast
measured with a tool (tokens chosen for AA), Firefox/Safari.
