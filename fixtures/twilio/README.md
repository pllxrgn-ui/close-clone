# Recorded Twilio webhook fixtures (task 3a)

Deterministic, replayable captures of the webhook traffic Twilio POSTs for voice
and SMS — the exact form-encoded, `X-Twilio-Signature`-signed payloads that hit
`/wh/twilio/status` and `/wh/twilio/sms` (CONTRACTS §C7, ARCHITECTURE §5). They let
the ingress / persist-then-process tests and the real Twilio adapter (task 3b)
replay realistic traffic **with zero external account**.

These are **generated, not hand-written**, by driving one deterministic
`MockTelephonyProvider` session and capturing its emitted wire payloads
(`apps/api/src/providers/telephony/twilio-fixtures.ts`). Signatures use
`MOCK_TWILIO_AUTH_TOKEN`, so `TelephonyProvider.verifyWebhook(headers, rawBody, url)`
accepts every fixture and rejects any tampering — the accept **and** reject ingress
paths are exercisable from disk.

## Envelope schema

One JSON object per file (one webhook delivery per file, so tests can reorder,
duplicate, or drop individual events):

```jsonc
{
  "provider": "twilio",
  "eventId": "string", // dedupe key → webhook_inbox unique (provider, provider_event_id)
  "channel": "voice" | "sms", // which ingress route this belongs to
  "url": "string", // exact URL the signature is computed over — REQUIRED to verify
  "receivedAt": "ISO-8601", // simulated ingest time (deterministic clock)
  "headers": { "X-Twilio-Signature": "…", "Content-Type": "application/x-www-form-urlencoded" },
  "rawBody": "string", // exact form-encoded bytes Twilio POSTed (the signature is over this)
  "payload": {} // parsed convenience view of rawBody (tests may ignore)
}
```

This follows the `fixtures/webhooks/README.md` (task 0c) envelope convention and
adds the two fields a Twilio replay needs that the generic schema omits: `channel`
and `url`. Twilio signs `url + sorted(name+value)`, so the URL must travel with the
fixture — `verifyWebhook` cannot run without it.

> Placement note: task 0c staked out `fixtures/webhooks/twilio/` for the same
> content; this task's allowlist named `fixtures/twilio/`. They are the same corpus.
> If the orchestrator prefers the `webhooks/` nesting, move this directory there and
> update `twilioFixturesDir()` in `twilio-fixtures.ts` (the single path constant).

## Streams

Files are processed in lexicographic filename order (zero-padded `NNNN-` prefixes),
which equals real chronological order; shuffling / duplicating files is how replay
and idempotency tests exercise the engine.

| Directory                    | What it is                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `voice-outbound-recorded/`   | Outbound call with recording armed (record + consent). Status + recording-status callbacks. §I-REC.   |
| `voice-outbound-unrecorded/` | Outbound call with recording OFF. No recording callbacks appear on the wire (negative §I-REC).        |
| `voice-inbound-voicemail/`   | Inbound call, rang unanswered, left a voicemail — carries `RecordingUrl` + `RecordingDuration`.       |
| `sms-inbound/`               | One inbound SMS per STOP/UNSUBSCRIBE/QUIT/CANCEL/END opt-out keyword (§I-QUIET) + one ordinary reply. |

The consent-announcement marker (`recording_consent_played`) is intentionally
absent: Twilio has no webhook for it, so it never appears in recorded traffic —
§I-REC is enforced at the adapter line, not on the wire.

## Regenerate

```
UPDATE_TWILIO_FIXTURES=1 pnpm --filter @switchboard/api test -- src/providers/telephony/twilio-fixtures.test.ts
```

Without the env var, the committed files are asserted byte-reproducible from the
generator (a drift lock). Cross-platform — no shell scripting, Node `fs`/`path` only.
