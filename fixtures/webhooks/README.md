# Recorded webhook fixtures

Replayable, deterministic captures of real provider webhook traffic. They drive
the idempotency property tests (CONTRACTS §I-SYNC, §C5) and the persist-then-process
ingestion tests (ARCHITECTURE §5) **without any external account** — the mock
providers replay these instead of hitting Gmail/Twilio.

## Format

- **One JSON file per event.** No arrays, no batching — a single webhook delivery
  per file, so individual events can be reordered, duplicated, or dropped by tests.
- **Ordering is by filename.** Files are processed in lexicographic filename order,
  so use zero-padded sequence prefixes: `0001-*.json`, `0002-*.json`, ….
  A stream replayed in filename order equals the real chronological order; shuffling
  or duplicating files is how the I-SYNC replay/reorder tests exercise the engine.
- **Filenames** are `NNNN-<short-slug>.json` (e.g. `0003-message-added.json`).

## Envelope schema

Each file is one object:

```jsonc
{
  "provider": "gmail" | "twilio",
  "eventId": "string",        // provider event id — the dedupe key (webhook_inbox unique)
  "receivedAt": "ISO-8601",   // simulated ingest time
  "headers": { "<name>": "<value>" }, // incl. signature headers for verifyWebhook()
  "rawBody": "string",        // exact bytes the provider POSTed (signature is over this)
  "payload": { }              // parsed convenience view of rawBody (tests may ignore)
}
```

## Directories

- `gmail/` — Pub/Sub push notifications (history-id advances, message adds/label
  changes) used by the email sync state machine (ARCHITECTURE §3).
- `twilio/` — voice + SMS lifecycle callbacks (`/wh/twilio/voice|sms|status`),
  including signed `X-Twilio-Signature` headers for the verify-on-every-ingress rule.

Captures are added alongside the sync/telephony work in Phase 2–3; Task 0c ships
the directory contract only.
