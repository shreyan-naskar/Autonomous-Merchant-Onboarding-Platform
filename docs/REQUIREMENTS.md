# Requirements and how to demo each one in the website

Every line of the problem statement ([PROBLEM.md](PROBLEM.md), same text as
`problem-statement.txt`), quoted, followed by what implements it and how to
show it in the website. Timings are from the running system with the default
settings (callbacks after 1.5s, verification timeout 30s). For a single
scripted run see [DEMO.md](DEMO.md); for the tests behind each failure
scenario see the README ("Failure scenarios").

## Before you start

```sh
npm run dev        # API :3000, mock providers :4000, website :5173
```

Open <http://localhost:5173>. The sidebar has *Operations* (**Applications**,
**Review queue**), *Merchant* (**Submit application**) and *Admin* (**Dead
letters**, **Demo controls**); the operational metrics are stat cards on the
**Applications** page.

On screen, states, reasons and events are written in plain words ("In review",
"PAN verified, GST verification failed", "Provider answered"); this guide
also names the underlying codes (`IN_REVIEW`, `PAN_OK_GST_FAILED`,
`VERIFICATION_RESULT`), which you can see by hovering or focusing a badge.
Every reviewer action opens a dialog that asks for a note (at least 5
characters) before it can be confirmed.

- **Start each demo clean:** **Demo controls** -> **Delete all data** ->
  **Delete everything** (deletes every application) and the switches go back
  to normal.
  This matters because of duplicate detection: submitting the same sample
  twice (most demos use `happy.json`) makes the second one a *possible
  duplicate*, held for a reviewer instead of auto-approved.
- **Submitting a sample:** **Submit application** -> click the sample's card
  under *Start from a sample* (each card says what it demonstrates and shows
  the file name) -> **Continue** -> **Continue** -> **Submit application**.
  The browser opens the application's page, which refreshes every 3 seconds.
- **Uploading files:** in step 2 (*Documents*) of **Submit application**,
  drop a file on **PAN card** / **GST certificate** / **Bank proof** (or
  click *Choose a file*). A file replaces the sample's structured document of
  the same type.
- Switches in **Demo controls** affect provider requests made *after* you flip
  them. Turn them off (or **Reset all**) when you are done.

---

## Customer context

> Incomplete documents, provider outages and inconsistent statuses create manual work and delays.

| Problem | Show it |
|---|---|
| Incomplete documents | Submit `missing.json`: the application stops in `NEEDS_INFO` and asks for the GST certificate (see journey step 5). |
| Provider outages | **Demo controls** -> **Provider outage** on, submit `happy.json`: retries, then **Dead letters** (see stretch: retry and dead-letter). |
| Inconsistent statuses | Statuses only change through the state machine; duplicate and late callbacks cannot move an application twice (failure scenarios 2 and 3). |

---

## Illustrative end-to-end user journey

### 1. A merchant submits an application and supporting documents.

*Implemented by:* `POST /applications` (JSON or multipart files); the **Submit application** page.

*Demo:* **Submit application** -> sample **Everything in order** (`happy.json`)
-> **Continue** -> **Continue** -> **Submit application**.
The form fields and three structured documents (PAN card, GST certificate,
bank proof) are sent; the application opens in `SUBMITTED`. To submit real
files instead, see core requirement 1.

### 2. The system extracts relevant fields and validates completeness and consistency.

*Implemented by:* the `extract` background job (format checks, document vs
form comparison, GSTIN-contains-PAN, name similarity, completeness).

*Demo:* on the `happy.json` page, **Extracted fields** lists seven fields with
confidence and an `ok` chip. For the failing side: `missing.json` (completeness
-> `NEEDS_INFO`) and `conflict.json` (consistency -> `IN_REVIEW`
`DOC_CONFLICT`, the PAN card name row shows `mismatch`).

### 3. It invokes simulated PAN, GST, bank and risk verification APIs.

*Implemented by:* `start_verifications` job -> mock providers on :4000.

*Demo:* on the `happy.json` page, the **Timeline** tab shows four "Check
requested from provider" rows (PAN, GST, Bank account, Risk) and the four
**Verification checks** cards show "Waiting for provider". **Demo controls** -> *Current
configuration* shows the provider settings.

### 4. It tracks asynchronous callbacks and updates the application state.

*Implemented by:* signed webhook `POST /webhooks/provider`, `evaluate()`.

*Demo:* about 1.5s after the requests, the cards turn green one by one; each
arrival is a `VERIFICATION_RESULT` row with actor **provider** in the
Timeline; when the fourth passes the status becomes `VERIFIED`
(`ALL_CHECKS_PASSED`). To slow it down for an audience, set **Demo controls**
-> **Callback delay** -> Seconds `8` -> **Set** first.

### 5. It requests missing information or routes exceptions to a human reviewer.

*Implemented by:* `NEEDS_INFO` with an "Information needed from the merchant"
panel; exceptions create review tasks in the **Review queue**.

*Demo, missing information:*
1. Submit `missing.json` (no GST certificate). Status `NEEDS_INFO`; the yellow
   panel says "Please upload your GST certificate." with a file input for it.
2. In the panel, choose `sample-data/missing-gst-cert.pdf` for **GST
   certificate** -> **Send information**.
3. Status goes `EXTRACTING` -> `VERIFYING` -> ... -> `MERCHANT_CREATED`;
   the GST fields appear at confidence 0.95 (read from the PDF).

*Demo, exception to a human:* submit `gst-fail.json` -> `IN_REVIEW` with task
`PAN_OK_GST_FAILED` -> **Review queue** shows it with the actions allowed in
that state (failure scenario 1).

### 6. Once required checks pass, it simulates merchant ID creation and records an audit trail.

*Implemented by:* `approve` job (risk <= 70) -> `create_merchant` job ->
simulated merchant ID service; `audit_log` for every step.

*Demo:* the `happy.json` page reaches `APPROVED` (`AUTO_APPROVED`, expand it:
risk score and threshold) and `MERCHANT_CREATED` within about 3 seconds of
the submit; the header shows **Merchant ID** `MID-XXXXXXXX`. The **Timeline**
is the audit trail: every transition and event with actor and time.

---

## Core requirements

### Accept an application and sample documents or structured document payloads.

*Demo, structured payloads:* **Submit application** -> any sample card; step
2 shows its documents as "Structured data from the sample".

*Demo, files:* **Submit application** -> sample **Upload a PAN card**
(`ocr-pan.json`) -> **Continue** -> drop `sample-data/pan-sharp.png` on **PAN
card** -> **Continue** -> **Submit application**. Optionally also drop
`gst-cert.pdf` on **GST certificate** and `bank-proof.pdf` on **Bank proof**
(uploads replace the structured documents). The application completes to
`MERCHANT_CREATED`.

### Extract key fields and show confidence or validation status.

*Demo:* the **Extracted fields** card on any application: value (masked for
PAN / GSTIN / account), confidence bar, and a validation chip (`ok`,
`mismatch`, `missing`, `low_confidence`). Compare:

| Submit | What the card shows |
|---|---|
| `happy.json` | all `ok`, confidence 1.0 (structured JSON) |
| `ocr-pan.json` + `pan-sharp.png` | PAN card fields at about 0.9 (OCR confidence of those words) |
| ... + `gst-cert.pdf`, `bank-proof.pdf` | GST and bank fields at 0.95 (PDF text) |
| `low-confidence.json` | bank IFSC `low_confidence` at 0.5 (the document's IFSC is not a valid code) |
| `conflict.json` | PAN card name `mismatch` (similarity shown in the review note) |

### Call at least two simulated verification services.

*Demo:* four are called for every application: the four **Verifications**
cards (PAN, GST, BANK, RISK with score) on any application past extraction.

### Maintain explicit application states and transition rules.

*Implemented by:* `ALLOWED_TRANSITIONS` + `transition()` (the only writer of
status, with guards); state diagram in the README.

*Demo:*
- Status badges on **Applications** (filter by status) and every page.
- **Timeline**: each transition as `from -> to` with its event and actor.
- **Review queue** only offers the actions legal in the application's state
  (e.g. `MERCHANT_CREATION_FAILED` offers only *Retry merchant creation*).
- A guard refusing a transition: failure scenario 4 (Approve answered 409
  "Cannot approve: BANK is pending for bank version 2 ...").

### Handle asynchronous callback events.

*Demo:* journey step 4, plus failure scenarios 2 (duplicate) and 3 (late).

### Provide an operator view of status, missing information and exceptions.

*Demo:*
- **Applications**: every application with status, time in state, open review
  count, merchant ID; status filter.
- Application page: the yellow **Information needed** panel (submit
  `missing.json`), **Review tasks** with reason and note, **Timeline**.
- **Review queue**: all open exceptions, oldest first, with actions.
- **Dead letters**: jobs that failed every retry.

### Simulate approval and merchant ID creation only when configured checks pass.

*Demo:*
- `happy.json`: all four pass, risk below 70 -> approved, merchant ID issued.
- `gst-fail.json`: GST failed -> no approval, no merchant ID, `IN_REVIEW`.
- `high-risk.json`: all pass but risk 85 -> `IN_REVIEW` `HIGH_RISK`; only an
  operator **Approve** (dialog, with a note) approves it.
- The approval guard re-checks all four on every approval (failure scenario 4).

---

## Advanced / stretch requirements

### Use multimodal extraction for images or PDFs.

*Implemented by:* blur check (Laplacian variance) + Tesseract OCR for PNG, JPEG,
WebP and TIFF (several preprocessing passes until every field is found); PDF text
layer (pdfjs) for PDFs, with scanned pages rendered and OCR'd for missing fields;
same field rules as JSON.

*Demo:*
1. **Delete all data**. **Submit application** -> **Upload a PAN card** ->
   **Continue** -> **PAN card**: `pan-sharp.png` (optionally `gst-cert.pdf`,
   `bank-proof.pdf`) -> **Continue** -> **Submit application**.
   **Extracted fields**: PAN and name read from the image (~0.9), the rest
   from the PDFs (0.95). The first OCR downloads the English model (~10 MB),
   so do this once before the audience arrives.
2. **Delete all data**. Same, but `pan-blurry.png`: `IN_REVIEW`
   `BLURRY_DOCUMENT`, note "blur score 1.68 < threshold 30"; no OCR is run.
3. Real documents work too: upload your own PAN card photo / bank statement
   PDF (they stay on this machine; the page shows only masked values).

### Add duplicate application detection and entity matching.

*Implemented by:* normalized PAN, GSTIN, or account + IFSC match at submit ->
`POSSIBLE_DUPLICATE` task linking both; auto-approval is held while it is open.

*Demo:* **Delete all data**, submit `happy.json`, wait for `MERCHANT_CREATED`,
submit `happy.json` again. The second gets a `POSSIBLE_DUPLICATE` task
("Same PAN, GSTIN, bank account + IFSC as application ...", with a link to the
first) and, after its checks pass, stops in `IN_REVIEW` instead of being
auto-approved. **Review queue** -> **Reject** (or **Approve**) -> note -> confirm.
Entity matching across documents: `conflict.json` (names compared by
similarity, the GSTIN must contain the PAN).

### Implement a durable workflow or event-driven state machine.

*Implemented by:* state machine above; every step is a job in the SQLite
`jobs` table (survives restarts), driven by callbacks (events) and timers.

*Demo:* the Timeline of any application shows the event-driven progression
(requests, provider callbacks, timeouts, operator actions). Durability needs
one terminal step: set **Callback delay** to `15000`, submit `happy.json`,
press Ctrl+C on `npm run dev` while it is `VERIFYING`, start `npm run dev`
again. The application carries on: the callbacks were lost with the mock
process, so after the 30s timeout the API re-requests them
(`VERIFICATION_TIMED_OUT`, attempt 2) and completes. Set the delay back to
`1500`.

### Use a human-in-the-loop review queue for low-confidence or high-risk cases.

*Demo:*
- **Low confidence:** submit `low-confidence.json` -> `IN_REVIEW`
  `LOW_CONFIDENCE` (note: "BANK_PROOF.ifsc (invalid_format, confidence 0.5)").
- **High risk:** submit `high-risk.json` -> checks pass, risk 85 ->
  `IN_REVIEW` `HIGH_RISK`.
- **Review queue**: both listed as cards; click **Approve** / **Reject** /
  **Request info** / **Retry verification** -> a dialog asks for a note (the
  confirm button stays disabled under 5 characters, with a live count) ->
  confirm. The decision and note appear in the Timeline with actor
  **Reviewer**.

### Add retry policies, dead-letter handling and audit history.

*Demo, retries and dead letters (about 20 seconds):*
1. **Demo controls** -> **Provider outage** on (providers answer 503).
2. Submit `happy.json`. The Timeline shows `JOB_FAILED` rows with the next
   retry time (backoff 1s, 2s, 4s, 8s); after the 5th attempt (about 17s) a
   `JOB_DEAD` row and a `JOB_DEAD` review task.
3. **Dead letters**: the `start_verifications` job, 5/5 attempts, its error.
4. Turn **Provider outage** off. In **Dead letters**, **Requeue** -> note -> **Requeue**.
   The job runs again and the application completes to `MERCHANT_CREATED`;
   the `JOB_DEAD` task is resolved and `JOB_REQUEUED` (actor operator) is in
   the Timeline.

*Other retry policies:* verification timeouts are retried twice (failure
scenario 3 / the **Drop callback** switch), merchant ID creation 3 times
(failure scenario 5).

*Audit history:* the **Timeline** of every application.

### Show operational metrics such as time in state and exception rate.

*Demo:* the stat cards on the **Applications** page: **Applications**
(total), **Exception rate** (share of applications that ever needed a human
or the merchant), **Need attention now**, **Avg time verifying**,
*Applications by status* and *Average time in state*; the table below shows
each application's time in its current state (sortable). Run a few of the demos
above and watch the numbers change.

---

## Failure and exception scenarios

### 1. PAN verification succeeds but GST verification fails.

*Demo:* submit `gst-fail.json` (its GSTIN ends in `Z9`, which the mock GST
provider rejects). Within about 2s: PAN card green, GST red
(`GSTIN_INACTIVE`), status `IN_REVIEW`, task `PAN_OK_GST_FAILED` whose note
lists every check. **Review queue** -> **Reject** (or **Request info**) -> note -> confirm.
Alternative: **Demo controls** -> **Fail GST** on, then any sample.

### 2. The same callback arrives multiple times.

*Demo:* **Demo controls** -> **Duplicate callback** on, submit `happy.json`.
Every provider sends each callback twice with the same `event_id`. Each
verification card shows a blue **Duplicate ignored ×1** marker; the
Timeline has exactly four "Provider answered" rows, not eight, and the
application completes normally. Turn the switch off afterwards.

### 3. A callback arrives after the request timed out.

*Demo (about 50 seconds):* **Demo controls** -> **Late callback** on
(callbacks after 45s, the API times out at 30s), submit `happy.json`.
- At 30s: four `VERIFICATION_TIMED_OUT` rows and the checks are re-requested
  (attempt 2).
- At about 46s the original answers arrive: four `LATE_CALLBACK` rows, amber
  **late** markers on the cards; they are applied (not lost) and the
  application goes `VERIFIED` -> `MERCHANT_CREATED` (about 47s in total).
- Turn **Late callback** off.

*Related:* **Drop callback (timeout)** = no answer ever: after two retries
(about 94s) `IN_REVIEW` with task `PAN_TIMEOUT` (the first check to give up).

### 4. The merchant changes bank details after verification.

*Demo (about 30 seconds):*
1. Submit `high-risk.json`; it passes every check and waits in `IN_REVIEW`
   (`HIGH_RISK`), i.e. verified but not yet approved.
2. **Demo controls** -> **Callback delay** -> Seconds `15` -> **Set**.
3. On the application page, **Bank details** tab -> New account number
   `60200111122223` -> **Change bank details**. Version 2; the old bank
   check is marked "(replaced)" and a new one is waiting for the provider.
4. **Overview** tab -> in the "High risk score" task **Approve** -> note ->
   **Approve**: the dialog shows **"Can't approve yet"** (*the bank account
   check for the new bank details is still pending; all four checks must
   pass*; hover **details** for the API's 409 text). **Cancel**; the task
   stays open.
5. When the Bank account card turns green for version 2 (up to 15 s),
   **Approve** again -> `APPROVED` -> `MERCHANT_CREATED`. **Demo controls**
   -> **Reset all** restores the 1.5 s delay.

(On an application that is still `VERIFIED` the same change sends it back
through `IN_REVIEW` -> `VERIFYING` automatically and it is re-approved once
the new account passes; happy applications approve within a second, so the
`high-risk.json` route is the one you can see.)

### 5. Approval succeeds but merchant ID creation fails.

*Demo:* **Demo controls** -> **Fail merchant creation** on, submit
`happy.json`. It reaches `APPROVED`; then two `JOB_FAILED` rows (retry after
1s, 2s) and, on the 3rd failure, `MERCHANT_CREATION_FAILED` with a review task
(about 5 seconds). Turn the switch off -> **Review queue** (or the
application's **Retry merchant creation** button) -> note -> confirm -> `APPROVED` -> `MERCHANT_CREATED` with a merchant ID.
Only one merchant ID is ever issued per application.

### 6. A document is blurred or conflicts with the application form.

*Demo, conflict:* submit `conflict.json` (the PAN card is in the name of
"Ramesh Electricals Pvt Ltd", the form says "Ganesh Hardware Stores") ->
`IN_REVIEW` `DOC_CONFLICT`; **Extracted fields** shows the name `mismatch`;
no provider is called. **Review queue** -> **Request info** (merchant fixes it)
or **Reject**.

*Demo, blurred:* **Submit application** -> **Upload a PAN card** -> **Continue**
-> **PAN card**: `pan-blurry.png` -> **Continue** -> **Submit application** -> `IN_REVIEW` `BLURRY_DOCUMENT` ("blur score 1.68 <
threshold 30"); no OCR, no provider calls. With `pan-sharp.png` instead it
passes (delete all data between the two, or the second is also a possible
duplicate).

---

## Minimum successful demonstration

> Demonstrate one application from submission through verification to approval or justified escalation, including at least one asynchronous callback and one exception path.

1. **Delete all data**. **Demo controls** -> **Duplicate callback** on.
2. Submit `happy.json`: extraction -> four asynchronous callbacks (duplicates
   ignored) -> `VERIFIED` -> `APPROVED` -> `MERCHANT_CREATED` with a merchant
   ID; walk the Timeline. Turn **Duplicate callback** off.
3. Exception path: submit `gst-fail.json` -> `IN_REVIEW` `PAN_OK_GST_FAILED`
   -> **Review queue** -> **Reject** -> note -> **Reject**.

Click-by-click with curl fallbacks: [DEMO.md](DEMO.md). Unattended:
`npm run demo` (stop `npm run dev` first: if it is running the demo reuses it
and **deletes its data**).

---

## What this challenge is designed to reveal

| Area | Where to point in the website |
|---|---|
| Workflow design | Status badges, Timeline, the state diagram in the README |
| Document intelligence | Extracted fields with confidence; image / PDF uploads; blurry and conflicting documents |
| State management | Guarded transitions (409 on early approval), duplicate / late callbacks without double effects |
| Integration resilience | Demo controls: outage, duplicate, late, dropped callbacks, merchant ID failure; Dead letters |
| Human review | Review queue, required notes, operator actions in the Timeline |
| Responsible handling of sensitive information | PAN, GSTIN and account numbers masked everywhere (header, fields, Timeline details); notes containing a PAN are masked too; logs are redacted (see README) |
