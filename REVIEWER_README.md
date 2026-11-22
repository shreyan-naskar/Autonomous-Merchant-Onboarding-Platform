# Reviewer guide

How to run the platform from a fresh clone and reproduce every scenario in
the problem statement. About 15 minutes end to end; the longest single wait
is 50 seconds.

For the design, see [README.md](README.md).

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20 or newer (developed on 24) | `node -v` |
| npm | comes with Node | `npm -v` |
| git | any | `git --version` |
| A browser | any current one | |

Linux, macOS and Windows all work. No database, Docker or API keys are
needed: storage is a local SQLite file and every external provider is a
mock that runs on your machine.

Ports used: **3000** (API), **4000** (mock providers), **5173** (web UI).
Free them first (see [Troubleshooting](#7-troubleshooting)).

## 2. Install and check

```sh
git clone https://github.com/shreyan-naskar/Autonomous-Merchant-Onboarding-Platform.git
cd Autonomous-Merchant-Onboarding-Platform
npm install
npm run ocr:warm
npm test
```

`npm run ocr:warm` downloads the OCR model (about 5 MB) once, so image
uploads work without internet later. Expect `Tests  ... passed` with no
failures; with the model cached, the tests that use real OCR run too.

Optional, about 20 seconds: an unattended end-to-end run of the main path.

```sh
npm run demo
```

It ends with `Demo passed.` and shows two audit trails: one application
reaching `MERCHANT_CREATED`, and one going `IN_REVIEW -> REJECTED`.

## 3. Start the app

```sh
npm run dev
```

Wait for three services to report ready, then open
**<http://localhost:5173>**.

What you are looking at:

- **Left sidebar**
  - **Operations:** Applications, Review queue
  - **Merchant:** Submit application, Scenarios
  - **Admin:** Dead letters, Demo controls
- **Top bar:** search, and a dot that is green while the API is reachable.
- **Amber banner:** shown on every page while a simulated failure switch is
  on. **Turn all off** clears it.
- **Hover over any status or reason badge** to see the underlying code
  (e.g. `IN_REVIEW`, `PAN_OK_GST_FAILED`).

Start clean: **Demo controls** → **Delete all data** → **Delete
everything**. The Applications page now shows "No applications".

## 4. Minimum successful demonstration

> Demonstrate one application from submission through verification to
> approval or justified escalation, including at least one asynchronous
> callback and one exception path.

### 4a. Submission → verification → approval, with asynchronous callbacks

1. **Scenarios** → card 2, *The same callback arrives multiple times.* →
   **Start**. This turns on duplicate callbacks and opens **Submit
   application** prefilled.
2. **Continue** → **Continue** → **Submit application**. The confirmation
   reads *Submitted for verification* with a reference.
3. **Go to applications** → open the newest row (it refreshes every 3 s).
4. What to point at:
   - **Stepper:** Submitted → Extraction → Verification → Verified →
     Approved → Merchant created, filling in as each step completes.
   - **Header:** PAN and GSTIN are masked (`******234K`). The API masks
     them, not the browser.
   - **Extracted fields:** seven values read from the three documents, each
     with a confidence and a check against the form.
   - **Verification cards:** PAN, GST, Bank account and Risk start as
     *Awaiting callback*. They turn *Passed* when each provider's
     asynchronous callback arrives. Each card shows **Duplicate ignored ×1**:
     every callback was sent twice, and the second copy was recorded and
     ignored.
   - **Header:** a **Merchant ID (MID)** such as `MID-XXXXXXXX`.
   - **Timeline tab:** the full audit trail. "Callback received" appears 4
     times, not 8, followed by "All verifications passed", "Approved
     automatically" and "Merchant ID issued". Each row has an actor and a
     time; **Details** shows the event payload.
5. Click **Turn all off** in the amber banner.

### 4b. Exception path and justified escalation

1. **Scenarios** → card 1, *PAN verification succeeds but GST verification
   fails.* → **Start** → **Continue** → **Continue** → **Submit
   application** → **Go to applications** → newest row.
2. Within a few seconds the status is **In review**. PAN shows **Passed**,
   GST shows **Failed**, and a review task reads *PAN verified, GST
   verification failed*.
3. **Review queue** (the sidebar shows a count) lists the task with only the
   decisions that can succeed. Approve is withheld, with the reason
   *Approval unavailable: verification incomplete.*
4. **Reject** → type a note of at least 5 characters → **Reject**. The
   status becomes **Rejected**, and the decision and note appear in the
   Timeline.

## 5. Failure and exception scenarios

Each case in the problem statement has a card on the **Scenarios** page
with the exact caption, its **Setup** and its **Expected outcome**.
**Start** does three things:
- **Switches:** sets the simulated-failure switches the case needs and turns
  all others off.
- **Sample data:** prefills a sample application.
- **Fresh identifiers:** gives the application new PAN, GSTIN and account
  digits, so an earlier run is never flagged as a duplicate.

The common steps for every scenario below are:

> **Scenarios** → card → **Start** → **Continue** → **Continue** →
> **Submit application** → **Go to applications** → open the newest row.

When you finish, click **Turn all off** in the banner (or **Demo controls**
→ **Reset all**).

### 5.1 PAN verification succeeds but GST verification fails

- **Card 1.** The sample's GSTIN ends in `Z9`, which the mock GST provider
  rejects.
- **Expect:** **In review**. PAN **Passed**, GST **Failed**
  (`GSTIN_INACTIVE` on hover). Review task: *PAN verified, GST verification
  failed*.
- **Then:** decide in the **Review queue**: **Reject**, **Request
  information** (sends the application back to the merchant) or **Re-run
  verification**.

### 5.2 The same callback arrives multiple times

- **Card 2** (turns on *Duplicate callback*).
- **Expect:**
  - Each verification card shows **Duplicate ignored ×1**.
  - The Timeline has exactly four "Callback received" rows.
  - The application still reaches **Merchant created**, with one MID.
- **Why it is safe:** callbacks are deduplicated by event ID before
  anything changes state.

### 5.3 A callback arrives after the request timed out

- **Card 3** (provider callbacks arrive at 45 s; the API's timeout is 30 s).
- **Expect, about 50 s in total:**
  - At about 30 s: four "Verification timed out" rows in the Timeline, and
    the requests are retried.
  - At about 45 s: four "Late callback applied" rows. The cards show
    **Late ×1**, the answers are applied, not lost, and the application
    reaches **Merchant created**.
- **Related, optional:** **Demo controls** → *Drop callback (timeout)* on,
  then submit the *Kaveri Looms* upload from [section 6](#6-more-to-try-optional).
  (Starting a scenario card would turn the switch off again.) No callback
  ever arrives; after two retries (about 95 s) the application goes to
  **In review** with *PAN verification timed out*.

### 5.4 The merchant changes bank details after verification

Uses a high-risk merchant, whose checks all pass but whose risk score (85)
holds it **In review** before approval. Two browser tabs show the approval
guard at work.

1. **Card 4** → submit → open it. Wait for **In review** with *High risk
   score*. All four verification cards are **Passed**.
2. **Demo controls** → **Callback delay** → `15` → **Set**. This leaves 15 s
   to watch the new bank verification.
3. **Tab 1:** on the application, click **Approve** in the review task and
   type a note. **Do not confirm yet.**
4. **Tab 2:** same application → **Bank details** tab → New account number
   `60200111122223` → **Change bank details**.
   - Bank details version becomes 2.
   - The old bank row is marked *replaced* and a new one is *Awaiting
     callback*.
   - Only the bank account is re-verified; PAN, GST and Risk are untouched.
   - This tab no longer offers Approve.
5. **Tab 1:** confirm **Approve**. The API refuses it: *Approval
   unavailable: bank verification (new bank details) pending.* Click
   **Cancel**; the task stays open.
6. Once the bank card turns **Passed** for version 2 (up to 15 s), approve
   again with the note. The application goes **Approved → Merchant
   created**.
7. **Demo controls** → **Reset all** (restores the 1.5 s delay).

### 5.5 Approval succeeds but merchant ID creation fails

- **Card 5** (turns on *Fail merchant creation*).
- **Expect, about 15 s:**
  - The application is **Approved**.
  - The MID service fails three times with backoff.
  - The status becomes **Merchant ID failed**, with a review task.
- **Recover:**
  1. **Turn all off** in the banner.
  2. On the application, **Retry merchant creation** → note → confirm.
  3. The application goes **Approved → Merchant created**. Exactly one MID
     is ever issued.

### 5.6 A document is blurred or conflicts with the application form

**Conflict:**
- **Card 6.** The PAN card in the sample is in another business's name.
- **Expect:**
  - **In review**: *Document doesn't match the form*.
  - **Extracted fields** marks the name *Doesn't match*.
  - No provider is called.
  - In the review task, the **Uploads** buttons open each file next to the
    values read from it.

**Blurred:**
1. **Card 6** → **Start** → **Continue**.
2. On **PAN card**, drop `sample-data/pan-blurry.png` (or
   `sample-data/specimens/pan-specimen-blurry.png`). The file replaces the
   sample's structured PAN card.
3. **Continue** → **Submit application** → open it.
- **Expect:**
  - **In review**: *Document image too blurry*.
  - The Documents tab shows a low sharpness score.
  - No OCR runs and no provider is called.

If you skipped `npm run ocr:warm`, the first image upload downloads the OCR
model (about 5 MB), so it takes a little longer.

## 6. More to try (optional)

| Try | How | What happens |
|---|---|---|
| Real document upload, end to end | **Submit application** → type *Kaveri Looms Pvt Ltd*, PAN `AAKCK5678L`, GSTIN `29AAKCK5678L1Z4`, account `30210987654321`, IFSC `KKBK0008521` → upload `pan-specimen-tilted.jpg`, `gst-specimen-scanned.pdf`, `bank-specimen.pdf` from `sample-data/specimens/` → submit | The tilted photo is straightened and the scanned PDF is read by OCR; the application reaches **Merchant created** |
| Missing information | As above, but upload no GST certificate | **Needs information**. The panel asks for the GST certificate; uploading `gst-specimen.pdf` there continues the flow |
| Provider outage | **Demo controls** → *Provider outage* on → submit the Kaveri Looms upload above | After ~17 s the step appears in **Dead letters** (5/5 attempts, HTTP 503). Turn the outage off → **Requeue** → note; the application completes |
| Duplicate application | Submit the Kaveri Looms upload twice | The second gets *Possible duplicate application* and is held for a reviewer instead of approving automatically |

All files in `sample-data/` are synthetic and marked as not valid; see
[sample-data/README.md](sample-data/README.md).

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on 3000, 4000 or 5173 | Another process holds the port. Find it with `lsof -i :3000` (macOS/Linux) or `netstat -ano \| findstr :3000` (Windows) and stop it |
| `npm run demo` says it reuses running services | `npm run dev` is running. The demo then deletes that data; stop `npm run dev` first to keep it |
| Red banner: *Service unavailable. Reconnecting…* | The API is not running; check the `npm run dev` terminal |
| Amber banner will not go away | A failure switch is on: **Turn all off** |
| First upload is slow, or a dead letter says *OCR model unavailable* | The OCR model is not cached yet: run `npm run ocr:warm` with internet, then **Requeue** the dead letter |
| Want a clean slate | **Demo controls** → **Delete all data**, or stop the app and delete `api/data/app.db` |

## 8. Where things live

| Path | What |
|---|---|
| `api/` | Express API, state machine, job worker, extraction (OCR and PDF), review, audit |
| `mock-providers/` | Simulated PAN, GST, bank, risk providers and their failure switches |
| `web/` | React operations console |
| `shared/` | Types, schemas and plain-language labels used by both sides |
| `sample-data/` | Sample applications and synthetic documents |
