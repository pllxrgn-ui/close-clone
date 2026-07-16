# Switchboard

**A communication-first CRM for our sales team.** Reps live in their activity queue — calls, emails, and texts happen inside the CRM against a single per-lead timeline, and every feature exists to reduce the seconds between "I should contact this person" and "I am contacting this person."

> Internal tool: one company, our own reps, our own infrastructure. No billing, no multi-tenancy — replaced by SSO, RBAC, audit logging, and data ownership. Outreach compliance (consent, unsubscribe, DNC, quiet hours) is enforced in the engine, not the UI.

## What works today

- **Leads, contacts, opportunities** with typed custom fields, on an append-only activity timeline (the product's spine — every touch exactly once, ordered, attributed)
- **Smart Views** — saved dynamic filters in a small query DSL (`last_contacted < 7d ago and owner in (me)`) compiled to parameterized SQL; visual builder and raw-DSL editor share one AST and can never diverge (round-trip property-tested)
- **Gmail-model email sync engine** — history-id incremental sync as a resumable state machine; replay/reorder/duplicate any input and the state is byte-identical (property-tested with 32 seeds)
- **Sequence engine with proven never-events** — a step _never_ sends twice (transactional claim), _never_ after a reply or bounce (re-checked inside the send transaction, raced adversarially), _never_ to a suppressed/DNC address, _never_ outside the window or over the cap — 15 adversarial interleaving properties, 8–16 workers racing every claim
- **Telephony adapter layer** — mock provider with scripted call-lifecycle webhooks; signature verification pinned to Twilio's published test vector (real Twilio adapter is next phase)
- **CSV import** — streaming parse, typed mapping, dedupe (domain + email + trigram fuzzy name), dry-run preview, idempotent resumable commit; 10k rows in ~36s
- **Reporting** — rep activity, currency-aware funnel, sequence performance
- **Audit & data ownership** — append-only audit log (DB-trigger-enforced), full JSON/CSV export with credential redaction, admin CLI (lookup, merge-leads, hard-delete with audit trail)
- **The web app** — keyboard-first (command palette, `J/K`, `G` chords), dense "Operator Grid" interface where color is spent entirely on state, dark + light themes, WCAG AA

**1,658 tests green** (917 api · 656 web · 85 shared) including golden-set, hostile-input injection, and adversarial-interleaving property suites. Two phase gates passed with independent verification.

## Run it locally (zero external accounts)

```bash
pnpm install

# Terminal 1 — real API on embedded Postgres (PGlite) + 5,000-lead fixture (~15s boot)
pnpm --filter @switchboard/api run dev:mock

# Terminal 2 — web app against the real API
VITE_API_MODE=real pnpm --filter @switchboard/web dev
# open http://localhost:5173/welcome
```

Or UI-only with in-browser demo data: `pnpm --filter @switchboard/web dev` (no terminal 1 needed). Tests: `pnpm test` · perf harness: `pnpm perf`.

## Architecture

pnpm monorepo: `apps/api` (Fastify + Drizzle + Postgres; Redis/BullMQ behind a queue driver), `apps/web` (React + Vite, MSW demo layer), `packages/shared` (zod contracts + the Smart View DSL compiler — the single query authority). All external I/O flows through four provider adapters (Email/Telephony/ASR/AI); `MOCK_MODE=1` swaps them with no code-path differences above the adapter line. Postgres is the only source of truth.

Read the law and the ledger: [ARCHITECTURE.md](ARCHITECTURE.md) · [CONTRACTS.md](CONTRACTS.md) · [DESIGN.md](DESIGN.md) · [DECISIONS.md](DECISIONS.md) · [DEMO.md](DEMO.md) · [STATUS.md](STATUS.md)

## Roadmap

Real Twilio calling/SMS + Deepgram transcription + Haiku summaries (adapters ready) · inbox/pipeline/reports UI (in flight) · OIDC SSO + RBAC · Playwright E2E · observability · one-command Docker deploy · security review.
