# Telephony adapter (task 3a)

`MockTelephonyProvider` — the in-memory `TelephonyProvider` (CONTRACTS §C2) for
`MOCK_MODE=1` and the telephony property/ingress suites. No real Twilio code (that
is task 3b); this is the adapter + its test instruments only.

## What's here

| File                         | Purpose                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock-telephony-provider.ts` | The C2 provider + `createMockTelephonyProvider(opts)` factory. Scripted call-lifecycle streams, clock-gated `emitWebhook`/`pump` delivery, consent-gated recording (§I-REC), idempotent `sendSms`, send/dial counters. |
| `twilio-signature.ts`        | Twilio HMAC-SHA1 request-signature scheme (`signTwilioForm`/`verifyTwilioSignature`). Standalone; verified against Twilio's published test vector.                                                                     |
| `twilio-wire.ts`             | Twilio-shaped form-encoding of lifecycle/inbound-SMS events + the pure lifecycle **step builders** `dial()` uses (`defaultOutboundSteps`, `inboundVoicemailSteps`).                                                    |
| `opt-out.ts`                 | §I-QUIET opt-out keyword set + `matchOptOutKeyword` (single source of truth).                                                                                                                                          |

## Determinism

Inject `clock` (`ManualClock`) and `ids` (`SequentialIds`) — no `Date.now()` /
`Math.random()` in behaviour, so a scripted stream replays byte-identically.
Webhook timing is controlled purely by advancing the injected clock and calling
`pump()`; there are no real timers.

## Registry wiring (for the Phase 2 chain that owns `../registry.ts`)

This task must not edit the shared registry/composition root. To bind the mock,
apply these edits to `apps/api/src/providers/registry.ts`:

1. Import the factory and interface:
   ```ts
   import type { EmailProvider, TelephonyProvider } from '@switchboard/shared/providers';
   import { createMockTelephonyProvider } from './telephony/index.ts';
   ```
2. Add `telephony` to the registry shape:
   ```ts
   export interface ProviderRegistry {
     email: EmailProvider;
     telephony: TelephonyProvider;
   }
   ```
3. Bind it in the mock branch of `createProviderRegistry`:
   ```ts
   if (config.mockMode) {
     return {
       email: new MockEmailProvider(mockOverrides),
       telephony: createMockTelephonyProvider({
         ...(mockOverrides.clock ? { clock: mockOverrides.clock } : {}),
         ...(mockOverrides.ids ? { ids: mockOverrides.ids } : {}),
       }),
     };
   }
   ```
   The real branch stays `throw` until task 3b lands the Twilio adapter.

`index.ts` re-exports the class, factory, signature helpers, wire encoders, and the
opt-out classifier for the engine + ingress code to consume.
