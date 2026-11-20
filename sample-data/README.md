# Sample payloads

JSON bodies for `POST /applications`. From the repo root:

```sh
curl -X POST localhost:3000/applications -H 'content-type: application/json' -d @sample-data/happy.json
```

Each file uses its own PAN, GSTIN and bank account, so they don't collide with
each other (relevant once duplicate detection exists). In every file the GSTIN
embeds the PAN (characters 3-12), as a real GSTIN does.

| File | What is special | Trigger | Expected path |
|---|---|---|---|
| `happy.json` | nothing | all values consistent, no magic values | extraction OK -> `VERIFYING` -> `VERIFIED` -> `APPROVED` -> `MERCHANT_CREATED` |
| `gst-fail.json` | GSTIN `29AACCM5678P1Z9` | **GST ending `Z9`**: the mock GST provider fails it | PAN passes, GST fails -> `IN_REVIEW` (`PAN_OK_GST_FAILED`) |
| `conflict.json` | PAN card name `Ramesh Electricals Pvt Ltd` vs form `Ganesh Hardware Stores` | document name differs from form name | `IN_REVIEW` with review task `DOC_CONFLICT` |
| `missing.json` | no `GST_CERT` document | required document missing | `NEEDS_INFO`, missing items listed in the audit detail |

Other magic values understood by the mock providers (not used by a file here,
set them in a copy of `happy.json` to try them):

| Value | Effect |
|---|---|
| PAN `ZZZZZ9999Z` (GSTIN must then embed it, e.g. `27ZZZZZ9999Z1Z5`) | PAN verification fails |
| Bank account ending `0000` | bank verification times out (no callback) |

The API's in-process worker runs extraction (Phase 3): `happy.json` and
`gst-fail.json` reach `VERIFYING`, `conflict.json` lands in `IN_REVIEW`,
`missing.json` in `NEEDS_INFO`. Paths beyond `VERIFYING` need the mock
providers (Phase 4).

To complete `missing.json`, PATCH the missing document (documents are only
accepted while the application is in `NEEDS_INFO`):

```sh
curl -X PATCH localhost:3000/applications/<id> -H 'content-type: application/json' \
  -d '{"documents":[{"type":"GST_CERT","payload":{"gstin":"33AAECS3456R1Z1","legal_name":"Sunrise Bakery"}}]}'
```

It moves `NEEDS_INFO -> EXTRACTING`, is re-extracted, and reaches `VERIFYING`.

## Multipart

The same fields as form parts; files go in parts named after their document
type (`PAN_CARD`, `GST_CERT`, `BANK_PROOF`; PDF, PNG or JPEG, max 5 MB).
Structured documents can be sent alongside as a JSON `documents` part.

```sh
curl -X POST localhost:3000/applications \
  -F merchant_name='Lakshmi Textiles Pvt Ltd' -F pan=AABCL1234K -F gst=27AABCL1234K1Z5 \
  -F bank_account=50100234567891 -F ifsc=HDFC0001234 \
  -F PAN_CARD=@/path/to/pan.pdf
```
