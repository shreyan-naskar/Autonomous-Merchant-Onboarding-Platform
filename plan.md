# Merchant Onboarding Workflow: 24-Hour Build Plan

Instructions for Claude Code: work through the phases **in order**. Finish each phase's "Done when" checks before moving on. Commit after every phase. If a phase runs over its time box, cut scope using the "Cut list" at the bottom, never skip the demo script.

## Goal

One working vertical slice: a merchant application goes from submission to verification (async callbacks) to approval and merchant ID creation, or to a justified escalation, with an operator dashboard, audit trail, and at least one exception path.

Repo layout:

```
/api              Express app (port 3000)
/mock-providers   Fake PAN/GST/bank/risk services (port 4000)
/web              React operator + merchant UI (port 5173)
/shared           Zod schemas and types shared by all three
/scripts          demo.ts, seed data
/sample-data      sample JSON payloads, sample PDFs/images
```

---

## Stack (all open source, Fedora compatible)
 
| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 20+ LTS, TypeScript | `sudo dnf install nodejs npm` |
| API | Express + Zod | Zod for request and extraction schemas |
| DB | SQLite via `better-sqlite3` + Drizzle ORM | No server to run. Keep SQL simple so Postgres is a drop-in later |
| Jobs | DB-backed `jobs` table + in-process worker (`setInterval`) | Retries with backoff and a `dead` status serve as the dead-letter queue. No Redis |
| State machine | Hand-rolled `ALLOWED_TRANSITIONS` map | One `transition()` function is the only writer of status |
| Mock providers | Separate Express app on port 4000 | PAN, GST, bank, risk, with chaos config |
| Extraction | JSON payloads first. Stretch: `pdf-parse` + `tesseract.js` OCR (`sharp` for blur check) | `sharp` needs no system packages on Fedora |
| Frontend | React + Vite + Tailwind, TanStack Query polling | |
| Logging | Pino with redaction | Mask PAN and bank numbers |
| Tests | Vitest + Supertest | |
| Dev | npm workspaces, `concurrently` | Podman is optional, skip containers if short on time |

## Phase 1: Domain model and state machine

**States:** `SUBMITTED`, `EXTRACTING`, `NEEDS_INFO`, `VERIFYING`, `IN_REVIEW`, `VERIFIED`, `APPROVED`, `MERCHANT_CREATED`, `MERCHANT_CREATION_FAILED`, `REJECTED`.

**Transitions (encode as a map, reject everything else):**

```
SUBMITTED -> EXTRACTING
EXTRACTING -> NEEDS_INFO | VERIFYING | IN_REVIEW
NEEDS_INFO -> EXTRACTING            (merchant supplies info)
VERIFYING -> VERIFIED | IN_REVIEW | REJECTED
VERIFIED -> APPROVED | IN_REVIEW    (IN_REVIEW if bank details changed)
IN_REVIEW -> VERIFYING | APPROVED | REJECTED | NEEDS_INFO
APPROVED -> MERCHANT_CREATED | MERCHANT_CREATION_FAILED
MERCHANT_CREATION_FAILED -> APPROVED  (retry)
```

**Tables (Drizzle):**
- `applications` (id, status, merchant_name, pan, gst, bank_account, ifsc, bank_version, created_at, updated_at, state_entered_at, merchant_id nullable)
- `documents` (id, application_id, type, path, blur_score, created_at)
- `extracted_fields` (id, application_id, document_id, field, value, confidence, validation_status `ok|mismatch|missing|low_confidence`)
- `verifications` (id, application_id, kind `PAN|GST|BANK|RISK`, status `PENDING|PASSED|FAILED|TIMED_OUT`, request_id, attempt, requested_at, completed_at, raw_response)
- `callback_events` (event_id UNIQUE, application_id, kind, payload, received_at, processed boolean, note)
- `audit_log` (id, application_id, at, actor `system|operator|provider|merchant`, from_state, to_state, event, detail JSON)
- `review_tasks` (id, application_id, reason, status `OPEN|RESOLVED`, resolution, created_at, resolved_at)
- `jobs` (id, type, payload, run_at, attempts, max_attempts, status `queued|running|done|failed|dead`, last_error)

**Build:**
1. Schema and migration script.
2. `transition(appId, to, {actor, event, detail})`: validates against the map, updates status and `state_entered_at`, writes `audit_log`, all in one DB transaction.
3. Unit tests: every legal transition passes, a sample of illegal ones throw, audit row written.

**Done when:** `vitest` passes for the state machine and a script can create an application and walk it through states.

## Phase 2: Application intake API

1. `POST /applications` accepts multipart (fields + files) or JSON with `documents: [{type, payload}]` where payload is a structured document (e.g. `{ pan: "ABCDE1234F", name: "..." }`). Validate with Zod. Create application in `SUBMITTED`, enqueue an `extract` job.
2. `GET /applications`, `GET /applications/:id` (include fields, verifications, review tasks, audit log).
3. `PATCH /applications/:id` for merchant updates (info for `NEEDS_INFO`, bank changes).
4. Pino redaction for `pan`, `bank_account`; helper `mask()` used in every API response to the UI (show last 4 only).
5. Sample payloads in `/sample-data`: `happy.json`, `gst-fail.json`, `conflict.json`, `missing.json`.

**Done when:** curl with `happy.json` creates an application and `GET` shows it with masked fields and one audit row.

## Phase 3: Worker and extraction/validation

1. Worker loop: pick due `queued` jobs, mark `running`, execute, on error increment attempts and reschedule with exponential backoff, after `max_attempts` mark `dead` and create a `review_task`. Write audit entries for job failures.
2. `extract` job for structured payloads: map payload to `extracted_fields` with confidence (1.0 for structured JSON, lower if value fails format).
3. Validators (pure functions, unit tested): PAN regex `^[A-Z]{5}[0-9]{4}[A-Z]$`, GSTIN 15-char format and that characters 3-12 equal the PAN, IFSC regex, name match between form and document (normalized, simple similarity).
4. Decision after extraction:
   - Missing required fields: `NEEDS_INFO` with a list of missing items stored in the audit detail.
   - Mismatch between form and document: `IN_REVIEW` plus `review_task` (reason `DOC_CONFLICT`).
   - Confidence below threshold (0.8): `IN_REVIEW` (reason `LOW_CONFIDENCE`).
   - Else: `VERIFYING`, enqueue `start_verifications`.

**Done when:** `missing.json` ends in `NEEDS_INFO`, `conflict.json` ends in `IN_REVIEW`, `happy.json` reaches `VERIFYING`.

## Phase 4: Mock providers and callbacks

**Mock provider app (`/mock-providers`):**
1. `POST /pan/verify`, `/gst/verify`, `/bank/verify`, `/risk/score`: each returns `202 {request_id}` immediately, then after a configurable delay POSTs a callback to `WEBHOOK_URL` with `{event_id, request_id, kind, result, application_ref}` signed with HMAC (`X-Signature`).
2. Chaos config via `POST /admin/config` and per-application overrides keyed by a magic value (for example PAN `ZZZZZ9999Z` fails, GST ending `Z9` fails, bank account ending `0000` times out): `delayMs`, `failKinds`, `duplicateCallback`, `dropCallback`, `lateCallbackMs`.
3. Risk returns a score 0-100; above 70 means high risk.

**API side:**
1. `start_verifications` job: create `verifications` rows (PENDING), call PAN and GST and bank and risk. Schedule a `verification_timeout` job per request (for example 30s in demo mode).
2. `POST /webhooks/provider`: verify signature, insert into `callback_events` with the unique `event_id`. On unique-violation: respond 200, log "duplicate ignored", do nothing else (idempotency).
3. Callback processing: update the matching verification. If it was already `TIMED_OUT`, record the late result, update the row to the actual outcome, write an audit entry `LATE_CALLBACK`, and re-evaluate (do not throw).
4. `evaluate(appId)` (called after every verification change): all four passed means `VERIFIED`; any failed means `IN_REVIEW` plus `review_task` with reason naming which check failed (for example `PAN_OK_GST_FAILED`); still pending means stay in `VERIFYING`.
5. Timeout job: if still PENDING, mark `TIMED_OUT`, retry up to 2 times with backoff, then `IN_REVIEW`.

**Done when (tests with the mock running):**
- Happy path reaches `VERIFIED`.
- Duplicate callback leaves exactly one effect and one extra `callback_events` row flagged duplicate.
- GST failure with PAN success lands in `IN_REVIEW` with the correct reason.
- Late callback after timeout is recorded and reconciled.

## Phase 5: Approval, merchant ID, bank change

1. `approve` logic: auto-approve when `VERIFIED` and risk below threshold, else `IN_REVIEW`. Operator can approve or reject via `POST /applications/:id/review` with resolution and note (audit actor `operator`).
2. `create_merchant` job after `APPROVED`: internal simulated service generates `MID-XXXXXXXX`, configurable failure flag. On success `MERCHANT_CREATED`, on failure retry with backoff, then `MERCHANT_CREATION_FAILED` and a review task. Operator "retry" action moves back to `APPROVED`.
3. Bank detail change after verification: `PATCH` with new bank details bumps `bank_version`, invalidates the BANK verification, moves to `IN_REVIEW` (or `VERIFYING` re-run bank only), audit entry `BANK_CHANGED`. Approval is blocked while a bank re-verification is pending.
4. Guard: `APPROVED` is only reachable if all configured required checks are `PASSED` for the current `bank_version` (enforce inside `transition()` as a guard).

**Done when:** a full happy run ends with `MERCHANT_CREATED` and an ID; forced create failure shows retry then `MERCHANT_CREATION_FAILED`; changing the bank after `VERIFIED` blocks approval.

## Phase 6: Operator and merchant UI

Build in this order, committing after each:

1. **Application list**: status badge, merchant name, time in state, open review count. Polling every 3s.
2. **Application detail**: state timeline (from audit log), extracted fields table with confidence bars and validation chips, verification cards (PAN/GST/bank/risk with status and attempt), missing-info panel, masked sensitive values.
3. **Review queue page**: open tasks with reason, approve / reject / request info buttons with a required note.
4. **Merchant submit page**: simple form with JSON-document textarea or file upload, plus a "load sample" dropdown for the sample payloads.
5. **Demo control panel**: buttons that set mock-provider chaos modes (fail GST, duplicate callback, drop callback/timeout, fail merchant creation) so every exception can be triggered live.
6. **Metrics strip**: average time in state per state, exception rate (applications that hit `IN_REVIEW` or `NEEDS_INFO` divided by total), computed from `audit_log` via `GET /metrics`.

**Done when:** the whole demo script below can be run from the browser only.

## Phase 7: Stretch, only if ahead of schedule

Pick in this order, stop when time is up:

1. **Blurry/conflicting document**: upload an image, `sharp` Laplacian variance blur score, below threshold means `IN_REVIEW` with reason `BLURRY_DOCUMENT`. OCR with `tesseract.js` to extract PAN and name and compare to the form.
2. **Duplicate detection**: normalized PAN/GST/bank-account match against existing applications on submit, create a review task `POSSIBLE_DUPLICATE`.
3. **Dead-letter view**: UI list of `dead` jobs with a "requeue" button.
4. **PDF text extraction** via `pdf-parse`.

## Phase 8: Hardening, docs, demo 

1. Run all tests. Add a test for each failure scenario in the brief:
   - PAN passes, GST fails
   - duplicate callback
   - late callback after timeout
   - bank details changed after verification
   - approval OK but merchant ID creation fails
   - blurred/conflicting document (if built)
2. `scripts/demo.ts`: drives one happy application and one exception application end to end and prints the audit trail.
3. Finish `README.md`:
   - Architecture diagram (Mermaid: state machine and component flow)
   - **Assumptions** (for example: required checks are PAN, GST, bank, risk; simulated providers; HMAC secret is a dev value)
   - **Mocked dependencies** (all four providers, merchant ID service)
   - **Limitations** (SQLite and in-process worker instead of durable queue, no auth, no real encryption at rest, polling not push)
   - **Production path** (Postgres, a real queue or Temporal, secrets manager, field-level encryption, role-based access)
   - **Responsible data handling** (masking, log redaction, no raw PAN/bank in logs, audit of operator actions)
4. Record or rehearse the demo twice. Tag the final commit.

---

## Demo script (minimum successful demonstration)

1. Submit `happy.json`. Show extraction with confidences, then `VERIFYING`.
2. Show async callbacks arriving and the timeline updating. Trigger a duplicate callback, show it ignored.
3. Application reaches `VERIFIED`, then `APPROVED`, then `MERCHANT_CREATED` with a merchant ID. Show the audit trail.
4. Submit `gst-fail.json`: PAN passes, GST fails, lands in `IN_REVIEW` with a clear reason. Operator rejects or requests info.
5. (Time permitting) change bank details on a verified application and show approval blocked, then show the metrics strip.

## Cut list (drop in this order if behind)

1. Phase 7 entirely.
2. Metrics strip.
3. Demo control panel UI (use curl and `scripts/demo.ts` instead).
4. Merchant submit page (use sample loader or curl).
5. Late-callback reconciliation (keep recording the event, skip re-evaluation).

Never cut: state machine with guards, idempotent callbacks, audit log, operator detail view, GST failure path, README assumptions.

## Working rules for Claude Code

- Make small commits, one per numbered step where practical.
- Write the test first for state machine, validators and idempotency.
- Never write status directly. Always call `transition()`.
- Never log or return raw PAN or bank numbers. Use `mask()`.
- Keep functions small and pure where possible so they are testable without the providers.
- After each phase, run `npm test` and the relevant curl or UI check, and report results before continuing.