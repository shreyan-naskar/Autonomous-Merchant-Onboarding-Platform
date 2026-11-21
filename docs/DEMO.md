# Live demo script

A click-by-click script for the minimum successful demonstration in
[PLAN.md](PLAN.md) ("Demo script"), about 8 minutes. Each step has a fallback
in case the browser misbehaves: a curl command, or `npm run demo`, which runs
steps 1-4 unattended and prints the audit trails.

**If everything fails:** stop `npm run dev` and run `npm run demo`. It starts
its own services on a fresh database and prints every check and both audit
trails (about 10 seconds).

Every requirement and scenario of the brief, one by one, with how to show it
in the website: [REQUIREMENTS.md](REQUIREMENTS.md).

## The website at a glance

- **Left sidebar**: *Operations* (Applications, Review queue with an open-task
  count), *Merchant* (Submit application), *Admin* (Dead letters with a count,
  Demo controls). On a phone it opens from the menu button.
- **Top bar**: page title, a search box (merchant name or application ID;
  press `/` to jump to it) and a dot that is green while the API answers.
- **Banners** under the top bar: amber while any demo failure mode is on (with
  *Turn all off*), red if the server can't be reached.
- Every status and reason is shown in plain words with an icon; hover (or
  focus) a badge to see the underlying code.

## Before the audience arrives

```sh
cd Autonomous-Merchant-Onboarding-Platform
npm install                 # once
npm test                    # expect: all passed
npm run dev                 # API :3000, mock providers :4000, web :5173
```

Open <http://localhost:5173> -> **Demo controls** -> **Delete all data** ->
**Delete everything** (deletes every application and resets the switches).
The **Applications** page now says "No applications yet".

Fallback: `curl -s -X POST localhost:3000/admin/reset-data; curl -s -X POST localhost:4000/admin/reset`
(and `sudo dnf install -y jq` for the curl fallbacks below).

Optional rehearsal: `npm run demo -- --external` resets and uses the running
services, but leaves 2 applications behind. Delete all data again afterwards.

## 1. Submit `happy.json`, show extraction and verification starting

1. **Demo controls** -> turn on **Duplicate callback** (the switch turns red;
   an amber banner appears on every page). This sets up step 2.
2. **Submit application** -> under *Start from a sample*, click **Everything
   in order** (`happy.json`). The business details fill in.
3. **Continue** (step 2 shows the three documents as "Structured data from the
   sample") -> **Continue** -> **Submit application**. A toast says
   "Application submitted" and the application's page opens.
4. Point at:
   - The header: PAN `******234K`, GSTIN `***********K1Z5`. Everything
     sensitive is masked by the API, not the UI.
   - The progress stepper: Submitted -> Extracting -> Verifying.
   - **Extracted fields** (Overview tab): 7 fields at 100% confidence, all
     **OK**. The GSTIN contains the PAN, and the names on all three documents
     match the form.

Fallback:
```sh
ID=$(curl -s -X POST localhost:3000/applications -H 'content-type: application/json' \
  -d @sample-data/happy.json | jq -r .id); echo $ID
curl -s localhost:3000/applications/$ID | jq '{status, pan, extracted_fields: [.extracted_fields[] | {field, value, confidence, validation_status}]}'
```

## 2. Asynchronous answers arrive; a duplicate answer is ignored

1. Stay on the page (it refreshes every 3 s). After about 1.5 s the four
   **Verification checks** cards turn green: PAN, GST, Bank account, Risk
   **Passed** (Risk shows its score).
2. Each card shows a blue **Duplicate ignored ×1** marker: every provider sent
   its answer twice with the same event ID; the API recorded the copy and did
   nothing else.
3. **Timeline** tab: four "Provider answered" rows (one per check, each with
   **Passed**), not eight, and one "All checks passed".
4. Click **Turn all off** in the amber banner (or switch **Duplicate callback**
   off in Demo controls).

Fallback (a single, deliberate redelivery of one already-delivered callback):
```sh
EVT=$(curl -s localhost:3000/applications/$ID | jq -r '.callbacks[0].event_id')
curl -s -X POST localhost:4000/admin/redeliver -H 'content-type: application/json' -d "{\"event_id\":\"$EVT\"}" | jq
# -> api_status 200, api_response.status "duplicate"
curl -s localhost:3000/applications/$ID | jq '[.callbacks[] | {kind, is_duplicate, note}]'
```

## 3. Verified -> Approved -> Merchant created; the audit trail

1. Within about a second of the last answer the status goes **Verified**,
   **Approved** (automatically: all four checks passed and risk is at most
   70), then **Merchant created**. Each change pops a toast ("Status changed
   to …") and the badge glows briefly; the stepper is all ticks.
2. The header shows **Merchant ID** `MID-XXXXXXXX` with a copy button.
3. **Timeline** tab, top to bottom: each row has an actor icon (merchant,
   system, provider, reviewer), a plain-language event and the state change.
   Expand **Details** on "Approved automatically" (risk score and threshold)
   and "Merchant ID issued" (the merchant ID).
4. Mention that only one function can change a status, and that every
   approval re-checks all four results.

Fallback:
```sh
curl -s localhost:3000/applications/$ID | jq '{status, merchant_id, trail: [.audit_log[] | select(.to_state) | "\(.actor): \(.from_state) -> \(.to_state) \(.event)"]}'
# or: npm run demo   (stop npm run dev first, or it will reset and reuse it)
```

## 4. Exception path: `gst-fail.json` -> In review -> reviewer rejects

1. **Submit application** -> sample **GST check fails** (`gst-fail.json`; its
   GSTIN ends in `Z9`, which the mock GST provider rejects) -> **Continue** ->
   **Continue** -> **Submit application**.
2. Within about 2 s: PAN **Passed**, GST **Failed**; the status becomes
   **In review** and the Overview tab shows a review task **"PAN verified, GST
   verification failed"** whose note lists each check.
3. **Review queue** (the sidebar badge shows 1): the task card with the
   merchant, its status, its age and only the actions allowed now: Approve,
   Reject, Request info, Retry verification.
4. Click **Reject**. A dialog asks for a note: type `no` and point out that
   **Reject** stays disabled and the counter reads "2 / 5 characters minimum"
   (the API refuses short notes too).
5. Type `GST registration inactive; rejecting.` and click **Reject**. Toast
   "Application rejected"; the card disappears from the queue.
6. Open the application (search for "Mysore" in the top bar): status
   **Rejected**, the stepper shows a red "Rejected" branch, and the Timeline
   has "Rejected by reviewer" (actor Reviewer) with the note in Details.
   - Alternative: **Request info** instead sends it back to the merchant
     (**Needs information**) and the page shows the "Information needed"
     panel.

Fallback:
```sh
GID=$(curl -s -X POST localhost:3000/applications -H 'content-type: application/json' \
  -d @sample-data/gst-fail.json | jq -r .id); sleep 4
curl -s localhost:3000/applications/$GID | jq '{status, tasks: [.review_tasks[] | {id, reason, note}]}'
TASK=$(curl -s localhost:3000/applications/$GID | jq '.review_tasks[0].id')
curl -s -X POST localhost:3000/applications/$GID/review -H 'content-type: application/json' \
  -d "{\"taskId\":$TASK,\"resolution\":\"REJECT\",\"note\":\"no\"}" | jq .error.details   # 400: note required
curl -s -X POST localhost:3000/applications/$GID/review -H 'content-type: application/json' \
  -d "{\"taskId\":$TASK,\"resolution\":\"REJECT\",\"note\":\"GST registration inactive; rejecting.\"}" | jq .status
```

## 5. (Time permitting) bank details change after verification blocks approval; metrics

Happy applications approve within a second, so use `high-risk.json`: its
checks pass but its risk score (85) holds it **In review** ("High risk score").

1. **Submit application** -> sample **High risk** -> **Continue** ->
   **Continue** -> **Submit application**. Wait for **In review** with the
   "High risk score" task (Risk card: 85, marked high).
2. **Demo controls** -> **Callback delay** -> Seconds `15` -> **Set**. This
   gives you 15 seconds to try approving before the new bank check answers.
3. Back on the application -> **Bank details** tab -> New account number
   `60200111122223` -> **Change bank details**. Toast "Bank details updated";
   the version goes to 2 and the bank check history shows the old result as
   "(replaced)" and a new check waiting for the provider.
4. **Overview** tab -> in the "High risk score" task click **Approve**, type
   `risk accepted after call`, click **Approve**. The dialog shows **"Can't
   approve yet"**: *"The bank account check for the new bank details is still
   pending. All four checks (PAN, GST, bank, risk) must pass before approval."*
   (hover **details** for the API's exact text). Click **Cancel**; the task
   stays open.
5. When the Bank account card turns green for version 2 (up to 15 s), click
   **Approve** again with the note: toast "Application approved", then
   **Merchant created**.
6. **Demo controls** -> **Reset all** (restores the 1.5 s delay).
7. **Applications**: the stat cards show totals, the exception rate (share of
   applications that needed a person or more information), how many need
   attention now, average time verifying, applications by status and average
   time in each state.

Fallback:
```sh
HID=$(curl -s -X POST localhost:3000/applications -H 'content-type: application/json' \
  -d @sample-data/high-risk.json | jq -r .id); sleep 4
curl -s -X POST localhost:4000/admin/config -H 'content-type: application/json' -d '{"delayMs":15000}' >/dev/null
curl -s -X PATCH localhost:3000/applications/$HID -H 'content-type: application/json' -d '{"bank_account":"60200111122223"}' | jq '{status, bank_version}'
HT=$(curl -s localhost:3000/applications/$HID | jq '[.review_tasks[] | select(.reason=="HIGH_RISK")][0].id')
curl -s -X POST localhost:3000/applications/$HID/review -H 'content-type: application/json' \
  -d "{\"taskId\":$HT,\"resolution\":\"APPROVE\",\"note\":\"risk accepted after call\"}" | jq .error   # 409 GUARD_FAILED
sleep 16
curl -s -X POST localhost:3000/applications/$HID/review -H 'content-type: application/json' \
  -d "{\"taskId\":$HT,\"resolution\":\"APPROVE\",\"note\":\"risk accepted after call\"}" | jq .status  # APPROVED
curl -s -X POST localhost:4000/admin/reset >/dev/null
curl -s localhost:3000/metrics | jq
```

## Extras if there are questions

- **Timeouts**: Demo controls -> **Drop callback (timeout)**, then submit a
  sample. Every check times out at 30 s and is retried twice with backoff;
  after about 95 s the application is **In review** with "PAN check timed
  out". Turn the switch off afterwards.
- **Dead letters**: Demo controls -> **Provider outage** on, submit
  `happy.json` (Delete all data first if it was submitted before), wait about
  20 s, then **Dead letters** (sidebar badge): "Send checks to providers",
  5/5 attempts, with its 503 error. Turn the outage off, click **Requeue**,
  type a note, **Requeue**: the application completes.
- **Blurry document / OCR**: **Submit application** -> sample **Upload a PAN
  card** -> **Continue** -> drop `sample-data/pan-blurry.png` on **PAN card**
  -> **Continue** -> **Submit application**: **In review**, "Document image too
  blurry" (Documents tab: sharpness about 2, blurry). With `pan-sharp.png` OCR
  reads the PAN and name at about 90% confidence. The first OCR downloads the
  model, so do one rehearsal run.
- **Duplicate application**: submit `happy.json` twice. The second gets a
  "Possible duplicate application" task linking the first, and is held **In
  review** instead of approving automatically.
- **Error pages**: open <http://localhost:5173/no/such/page> (404 inside the
  app) or `/applications/<any id>` (an application that doesn't exist). Stop
  the API and a red banner says "Can't reach the server, retrying…"; it
  disappears by itself when the API is back.
- **Failure scenarios as tests**: `npx vitest run api/src/scenarios.test.ts`.
