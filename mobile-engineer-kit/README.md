# Mobile Engineer - local candidate kit

This kit contains only invented data. It requires Node.js 20+ and no account, token, package install, or internet connection.

1. `npm start` starts the mock API at `http://127.0.0.1:8787`.
2. `npm run fixtures:oversize` creates the >10 MiB rejection fixture.
3. `npm test` verifies the mock itself.

For an Android emulator, `adb reverse tcp:8787 tcp:8787` lets the app use `http://127.0.0.1:8787`. The iOS simulator normally reaches the host loopback directly. For a physical device, configure an explicitly chosen LAN host; do not expose this test API to the internet.

## HTTP contract

`POST /imports`: raw PDF or CSV bytes (`Content-Type: application/octet-stream`), `Idempotency-Key: <stable random key>`, `X-File-Name: <name>`. The server checks the bytes, not the extension or supplied MIME type. Successful response: HTTP 202, `{jobId,status:"queued",revision:1}`. Repeating the same key and bytes returns the same job. Same key with different bytes returns 409. `POST` never represents a completed report.

`GET /imports/by-key/<key>`: recover a job after a lost create response. A 404 means not found *at that instant*; if the original request may still be in flight, retry the POST with the **same** key and bytes. `GET /imports/<jobId>`: authoritative job state. `DELETE /imports/<jobId>` with an `Idempotency-Key`: HTTP 202 and `deleting`, followed by `deleted` on a later GET. All state responses have monotonically increasing revisions in the normal scenario.

Only the mock's test-control routes are for reviewers, not production architecture: `POST /__test/reset`; `POST /__test/scenario` with `{"mode":"happy|lost_ack|stale_status|delete_failure"}`; `GET /__test/state`. `lost_ack` commits a job but drops the first response; `stale_status` returns ready/revision 3 and then an older processing/revision 2 for that job; `delete_failure` returns HTTP 503 without committing deletion. The reviewer can switch the scenario back to `happy` and retry.

The mock saves job metadata and a SHA-256 digest in `.mock-state.json` to survive mock restarts. It does not save statement bytes. `GET /__test/state` exposes request/job counts for verification. Reset is destructive only for the mock's local synthetic state.

## Fixed fixtures

- `fixtures/statement.csv`: accepted synthetic CSV.
- `fixtures/statement.pdf`: accepted synthetic PDF with the same made-up merchants.
- `fixtures/spoofed.pdf`: rejected; text masquerading as PDF.
- `fixtures/oversize.csv`: rejected; generate using the included command.

The app is not expected to parse statement transactions. The mock returns the fixed ready result described in the assignment PDF. Use the exact same kit for every candidate and do not edit its server when evaluating the mobile client.
