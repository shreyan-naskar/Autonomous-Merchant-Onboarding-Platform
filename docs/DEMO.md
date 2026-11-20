# Live demo script

A click-by-click script for the minimum successful demonstration in
[PLAN.md](PLAN.md) ("Demo script"), about 8 minutes. Each step has a fallback
in case the browser misbehaves: a curl command, or `npm run demo`, which runs
steps 1-4 unattended and prints the audit trails.

**If everything fails:** stop `npm run dev` and run `npm run demo`. It starts
its own services on a fresh database and prints every check and both audit
trails (about 10 seconds).

## Before the audience arrives

```sh
cd Autonomous-Merchant-Onboarding-Platform
npm install                 # once
npm test                    # expect: all passed
npm run dev                 # API :3000, mock providers :4000, web :5173
```

In a second terminal, start from an empty database with default chaos settings:

```sh
curl -s -X POST localhost:3000/admin/reset-data   # demo mode only: deletes all applications
curl -s -X POST localhost:4000/admin/reset
sudo dnf install -y jq                            # only needed for the curl fallbacks below
```

Open <http://localhost:5173>. The metrics strip at the top should read 0 applications.

Optional rehearsal: `npm run demo -- --external` resets and uses the running
services, but leaves 2 applications behind. Run the two reset commands again
afterwards.

## 1. Submit `happy.json`, show extraction and VERIFYING

1. Click **Demo controls** and turn on **Duplicate callback**. This sets up step 2: each provider will send its callback twice.
2. Click **Submit**. In **Load sample**, choose `happy.json`. The form and the JSON documents fill in.
3. Click **Submit application**. The browser opens the application's detail page.
4. Point at:
   - The header: PAN `******234K`, GSTIN `***********K1Z5`, account `**********7891`. Everything sensitive is masked by the API, not the UI.
   - **Extracted fields**: 7 fields, confidence 1.0, all `ok`. The GSTIN embeds the PAN, and the names on all three documents match the form.
   - **Timeline**: `SUBMITTED -> EXTRACTING -> VERIFYING`, then four `VERIFICATION_REQUESTED` rows.

Fallback:
```sh
ID=$(curl -s -X POST localhost:3000/applications -H 'content-type: application/json' \
  -d @sample-data/happy.json | jq -r .id); echo $ID
curl -s localhost:3000/applications/$ID | jq '{status, pan, extracted_fields: [.extracted_fields[] | {field, value, confidence, validation_status}]}'
```

## 2. Async callbacks arrive; a duplicate callback is ignored

1. Stay on the detail page (it refreshes every 3s). After about 1.5s, the four **Verifications** cards turn green one after another: PAN, GST, BANK, RISK `PASSED`, with RISK showing its score.
2. Each card shows a purple **duplicate ignored ×1** marker. The provider sent every callback twice with the same `event_id`. The API stored the second copy, flagged it as a duplicate, answered 200 and did nothing else.
3. In the **Timeline**, there are exactly four `VERIFICATION_RESULT` rows (not eight) and one `ALL_CHECKS_PASSED`.
4. Go back to **Demo controls** and turn **Duplicate callback** off.

Fallback (a single, deliberate redelivery of one already-delivered callback):
```sh
EVT=$(curl -s localhost:3000/applications/$ID | jq -r '.callbacks[0].event_id')
curl -s -X POST localhost:4000/admin/redeliver -H 'content-type: application/json' -d "{\"event_id\":\"$EVT\"}" | jq
# -> api_status 200, api_response.status "duplicate"
curl -s localhost:3000/applications/$ID | jq '[.callbacks[] | {kind, is_duplicate, note}]'
```

## 3. VERIFIED -> APPROVED -> MERCHANT_CREATED with a merchant ID; the audit trail

1. Within about a second of the last callback, the status badge goes `VERIFIED`, then `APPROVED` (auto-approved: all four checks passed and risk is at most 70), then `MERCHANT_CREATED`.
2. The header shows **Merchant ID** `MID-XXXXXXXX`.
3. Walk the **Timeline** top to bottom. Each row has an actor (merchant, system, provider), a `from -> to` transition and an event. Expand `AUTO_APPROVED` to show the risk score and threshold, and `MERCHANT_CREATED` to show the merchant ID.
4. Mention that only `transition()` can write a status, and that every approval passes a guard that re-checks all four results.

Fallback:
```sh
curl -s localhost:3000/applications/$ID | jq '{status, merchant_id, trail: [.audit_log[] | select(.to_state) | "\(.actor): \(.from_state) -> \(.to_state) \(.event)"]}'
# or: npm run demo   (stop npm run dev first, or it will reset and reuse it)
```

## 4. Exception path: `gst-fail.json` -> IN_REVIEW -> operator rejects

1. Click **Submit**, choose `gst-fail.json` in **Load sample** (its GSTIN ends in `Z9`, which the mock GST provider rejects), then click **Submit application**.
2. On the detail page, within about 2s: PAN `PASSED`, GST `FAILED` (`GSTIN_INACTIVE`). The status becomes `IN_REVIEW` and **Review tasks** shows an open `PAN_OK_GST_FAILED` task. Its note lists each check with its result.
3. Click **Review queue**. The task is listed with the merchant name and status. The buttons offered are only the actions valid in `IN_REVIEW`: Approve, Reject, Request info, Retry verification.
4. Type a too-short note (`no`) and point out that the buttons stay disabled. The API also refuses notes under 5 characters (400).
5. Type a note such as `GST registration inactive; rejecting.` and click **Reject**. The task disappears from the queue.
6. Open the application. The status is `REJECTED`, and the timeline shows `IN_REVIEW -> REJECTED` by **operator**, with the note and task in the detail.
   - Alternative: click **Request info** instead. The application goes to `NEEDS_INFO`, and the detail page shows the missing-info panel.

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

Happy applications auto-approve within a second, so use `high-risk.json`. Its merchant name contains `RISKY`, so it scores 85, passes every check and then waits in `IN_REVIEW` (`HIGH_RISK`).

1. **Submit** -> `high-risk.json` -> **Submit application**. Wait for `IN_REVIEW` with an open `HIGH_RISK` task (risk score 85 on the RISK card).
2. Open **Demo controls**, set **Callback delay (ms)** to `15000` and press Tab. This gives you 15 seconds to try approving before the new bank check answers.
3. Back on the detail page, under **Change bank details (merchant)**, enter account `60200111122223`, then click **Change bank details**. The header shows bank version 2. The old BANK card result is superseded, and a new BANK check is pending.
4. In the `HIGH_RISK` task, type a note (`risk accepted after call`) and click **Approve**. You get a red 409: *"Cannot approve: BANK is pending for bank version 2. All of PAN, GST, BANK, RISK must pass first."* The task stays open.
5. Wait for the BANK card to turn green for version 2 (up to 15s), then click **Approve** again. The status goes `APPROVED` -> `MERCHANT_CREATED`.
6. Set **Callback delay** back to `1500` (or click **Reset all**).
7. Point at the **metrics strip**: total applications, exception rate (the share of applications that ever needed a human), and average time in each state.

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

- **Timeouts**: Demo controls -> **Drop callback (timeout)**, then submit a sample. Every check times out at 30s and is retried twice with backoff. After about 95s the application is `IN_REVIEW` with a `<KIND>_TIMEOUT` task. Turn the switch off afterwards.
- **Dead letters**: Stop the mock providers (`kill $(lsof -ti tcp:4000)`; Ctrl+C would stop all of `npm run dev`), submit `happy.json`, wait about 20s, then open **Dead letters**: a `start_verifications` job after 5 attempts with its error. Restart the mocks (`npm run dev -w mock-providers`), type a note and click **Requeue**.
- **Blurry document / OCR**: **Submit** -> load `ocr-pan.json` -> attach `sample-data/pan-blurry.png` as the PAN card -> `IN_REVIEW BLURRY_DOCUMENT` (blur score about 1.7 against a threshold of 30). With `pan-sharp.png`, OCR reads the PAN and name at about 0.94 confidence. The first OCR downloads the model, so do one rehearsal run.
- **Duplicate application**: submit `happy.json` twice. The second gets a `POSSIBLE_DUPLICATE` task linking the first, and is held in `IN_REVIEW` instead of auto-approving.
- **Failure scenarios as tests**: `npx vitest run api/src/scenarios.test.ts`.
