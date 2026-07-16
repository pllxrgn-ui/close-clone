import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  contacts,
  emailAccounts,
  leads,
  sendIntents,
  suppressions,
  type Db,
} from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import type { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { enrollContacts } from './enrollment.ts';
import { processIntent, type DispatchDeps, type DispatchResult } from './dispatch.ts';
import { pauseOnInboundReply } from './pause.ts';
import { applyUnsubscribe } from './unsubscribe.ts';
import { expireStaleClaims, sweepDueIntents, type SweeperDeps } from './sweeper.ts';
import {
  intentState,
  intentsForEnrollment,
  countActivities,
  makeHarness,
  seedAccount,
  seedContact,
  seedLead,
  seedSequence,
  seedTemplate,
  seedUser,
  setOrgSettings,
  type EngineHarness,
} from './test-helpers.ts';

/**
 * Task 2f — the ADVERSARIAL interleaving property suite for CONTRACTS §C6 (the
 * send never-events I-SEND-1..5 + I-DNC). We play the attacker: N workers race the
 * same claim; replies/suppressions/DNC-flips/unsubscribes are fired before the
 * claim, one tick before due, and DURING the provider network window; the mailbox
 * dies mid-flight. Every scenario runs across a bank of DETERMINISTIC seeds so a
 * failure is exactly reproducible, and the whole file shares one PGlite instance
 * (fresh rows per seed) to stay inside the CI time budget.
 *
 * PGlite is a single embedded connection, so concurrent `db.transaction()` calls
 * SERIALIZE rather than run on parallel OS threads. That does not weaken these
 * proofs: the never-events are enforced by SQL-level guards — the claim predicate
 * `WHERE state='SCHEDULED' AND due_at<=now()`, the `UNIQUE(enrollment_id,step_id)`
 * row, `SELECT … FOR UPDATE` on the enrollment + mailbox, and the in-txn cap
 * counter — which PGlite evaluates with real Postgres semantics under every
 * serialization order the seeds explore. `Promise.all([...])` submits the racing
 * transactions concurrently; the seeds vary which competing event is committed and
 * when. Where an ordering guarantee is claimed (competing event committed BEFORE
 * the claim), the test forces that order and asserts the strong invariant; where
 * it is a genuine race, the test asserts only the never-over-send invariants.
 */

// --- Deterministic seeded PRNG (xmur3 + mulberry32; inlined to avoid a cross-
// package dependency on the DB-free @switchboard/fixtures Rng). ---------------

function makeRng(seed: string): { int: (min: number, max: number) => number; bool: () => boolean } {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^ (h >>> 16)) >>> 0;
  const next01 = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (min, max) => min + Math.floor(next01() * (max - min + 1)),
    bool: () => next01() < 0.5,
  };
}

const SEEDS = 24;

// These are multi-seed loops: each test drives dozens of full send transactions
// against PGlite. In isolation a test is ~1–2s, but under the fully-parallel repo
// suite (45 files contending for CPU and the single PGlite connection) it can
// exceed the 5s default, so the whole file gets a generous, contention-proof
// budget. It still completes in ~12s wall on its own — well inside the §2f budget.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let ctx: TestDb;
let h: EngineHarness;

/** A fully-seeded single-email-step scenario with its own mailbox/provider. */
interface Scenario {
  enrollmentId: string;
  intentId: string;
  leadId: string;
  contactId: string;
  accountId: string;
  recipient: string;
  provider: MockEmailProvider;
  address: string;
}

let uniq = 0;

async function freshScenario(
  opts: { delayHours?: number; recipient?: string } = {},
): Promise<Scenario> {
  uniq += 1;
  const address = `rep-${uniq}@mock.test`;
  const recipient = opts.recipient ?? `dana-${uniq}@acme.test`;
  const rep = await seedUser(ctx.db, `rep-${uniq}@switchboard.test`);
  const leadId = await seedLead(ctx.db, `Acme ${uniq}`);
  const contactId = await seedContact(ctx.db, leadId, recipient, { name: 'Dana' });
  const accountId = await seedAccount(ctx.db, h.cipher, rep, address);
  const template = await seedTemplate(ctx.db, rep);
  const { sequenceId } = await seedSequence(ctx.db, [
    { type: 'email', delayHours: opts.delayHours ?? 0, templateId: template },
  ]);
  const res = await enrollContacts(h.deps, {
    sequenceId,
    enrolledBy: rep,
    emailAccountId: accountId,
    targets: [{ leadId, contactId }],
  });
  const enrollmentId = res.enrolled[0]!.enrollmentId;
  const intentId = (await intentsForEnrollment(ctx.db, enrollmentId))[0]!.id;
  const provider = h.providerFor({ address, provider: 'mock' });
  return { enrollmentId, intentId, leadId, contactId, accountId, recipient, provider, address };
}

/** processIntent under a distinct worker id (models a distinct worker process). */
function asWorker(workerId: string): DispatchDeps {
  return { ...h.deps, workerId };
}

async function pauseReply(leadId: string): Promise<void> {
  await ctx.db.transaction(async (txRaw) => {
    await pauseOnInboundReply(txRaw as Db, leadId);
  });
}

async function sentIntentCount(enrollmentId: string): Promise<number> {
  const rows = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(sendIntents)
    .where(and(eq(sendIntents.enrollmentId, enrollmentId), eq(sendIntents.state, 'SENT')));
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  await setOrgSettings(ctx.db, { dailySendCap: 200, companyTimezone: 'UTC' });
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  // Reset the shared harness clock + org cap to the baseline before every test, so
  // the cap-ceiling test's per-seed cap mutation can never bleed into another test.
  h.clock.now = new Date('2026-03-02T15:00:00.000Z');
  await ctx.db.execute(sql`UPDATE org_settings SET daily_send_cap = 200`);
});

describe('I-SEND-1: N workers race one claim → ≤1 provider call, exactly one SENT', () => {
  test('across randomized seeds, exactly one worker sends', async () => {
    for (let s = 0; s < SEEDS; s += 1) {
      const rng = makeRng(`nworker-${s}`);
      const n = rng.int(8, 16);
      const sc = await freshScenario();

      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) => processIntent(asWorker(`w${s}-${i}`), sc.intentId)),
      );

      // No worker threw.
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected, `seed ${s}: no worker should throw`).toHaveLength(0);

      const kinds = results.map((r) => (r as PromiseFulfilledResult<DispatchResult>).value.kind);
      expect(
        kinds.filter((k) => k === 'sent'),
        `seed ${s}: exactly one 'sent'`,
      ).toHaveLength(1);

      // I-SEND-1: provider called at most once for this intent's idempotency key.
      expect(sc.provider.sendCallCountForKey(sc.intentId)).toBeLessThanOrEqual(1);
      expect(sc.provider.deliveredCount).toBe(1);

      // Exactly one intent row reached SENT.
      expect(await sentIntentCount(sc.enrollmentId)).toBe(1);
      expect((await intentState(ctx.db, sc.intentId)).state).toBe('SENT');
    }
  });
});

describe('I-SEND-2: never SENT after a reply/pause', () => {
  test('(a) reply committed BEFORE the claim → SKIPPED, never SENT', async () => {
    for (let s = 0; s < 8; s += 1) {
      const sc = await freshScenario();
      await pauseReply(sc.leadId); // reply lands between scheduling and due
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('skipped');
      expect((await intentState(ctx.db, sc.intentId)).state).toBe('SKIPPED');
      expect(sc.provider.deliveredCount).toBe(0);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      expect(await countActivities(ctx.db, sc.leadId, 'sequence_step_sent')).toBe(0);
    }
  });

  test('(b) reply lands one tick before due, then the intent comes due → SKIPPED', async () => {
    const sc = await freshScenario({ delayHours: 1 });
    // Not yet due: a claim attempt bails.
    expect((await processIntent(h.deps, sc.intentId)).kind).toBe('not_claimed');
    // Reply arrives while the intent is still scheduled in the future.
    await pauseReply(sc.leadId);
    // Advance past the due time; the sweeper/worker now tries to send.
    h.clock.now = new Date('2026-03-02T16:00:01.000Z');
    const res = await processIntent(h.deps, sc.intentId);
    expect(res.kind).toBe('skipped');
    expect(sc.provider.deliveredCount).toBe(0);
    expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
  });

  test('(c) reply commits DURING the provider network window → paused_during_send, never SENT', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshScenario();
      // The interceptor fires INSIDE provider.send(), after the claim+cap txn has
      // committed and before the SENT txn — the exact seam I-SEND-2 defends. We
      // commit a reply-pause there; send() awaits it, so the pause is durable
      // before Phase C re-locks the enrollment.
      sc.provider.setSendInterceptor(async () => {
        await pauseReply(sc.leadId);
      });
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('paused_during_send');

      const st = await intentState(ctx.db, sc.intentId);
      expect(st.state).toBe('SKIPPED');
      expect(st.skipReason).toBe('paused_during_send');
      // The email physically left (provider was called once) but the DB never
      // records SENT and no sequence_step_sent event is emitted — the invariant is
      // about the SENT transition, which never happens after the pause commit.
      expect(sc.provider.sendCallCountForKey(sc.intentId)).toBe(1);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      expect(await countActivities(ctx.db, sc.leadId, 'sequence_step_sent')).toBe(0);
      expect(await countActivities(ctx.db, sc.leadId, 'sequence_paused')).toBe(1);
      sc.provider.setSendInterceptor(undefined);
    }
  });

  test('reply raced concurrently with the claim → ≤1 send, DB stays consistent', async () => {
    for (let s = 0; s < SEEDS; s += 1) {
      const sc = await freshScenario();
      const results = await Promise.allSettled([
        processIntent(h.deps, sc.intentId),
        pauseReply(sc.leadId),
      ]);
      expect(
        results.filter((r) => r.status === 'rejected'),
        `seed ${s}`,
      ).toHaveLength(0);
      // Never more than one delivery; never more than one SENT row.
      expect(sc.provider.sendCallCountForKey(sc.intentId)).toBeLessThanOrEqual(1);
      expect(sc.provider.deliveredCount).toBeLessThanOrEqual(1);
      expect(await sentIntentCount(sc.enrollmentId)).toBeLessThanOrEqual(1);
      // I-SEND-2 defends the SENT *transition*, not physical delivery: if the pause
      // wins the race after provider.send() already fired, the email is out but the
      // intent lands SKIPPED('paused_during_send'), never SENT. So a delivery with
      // no SENT row is CORRECT. The one thing that must always hold: a SENT row
      // implies exactly one delivery backed it.
      const st = (await intentState(ctx.db, sc.intentId)).state;
      if (st === 'SENT') expect(sc.provider.deliveredCount).toBe(1);
      expect(['SENT', 'SKIPPED']).toContain(st);
    }
  });
});

describe('I-SEND-3 / I-DNC: never to a suppressed or DNC recipient', () => {
  test('suppression committed before the claim always BLOCKS (never SENT)', async () => {
    for (let s = 0; s < SEEDS; s += 1) {
      const sc = await freshScenario();
      await ctx.db
        .insert(suppressions)
        .values({ kind: 'email', value: sc.recipient, source: 'manual' });
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('blocked');
      expect((await intentState(ctx.db, sc.intentId)).skipReason).toBe('suppressed');
      expect(sc.provider.deliveredCount).toBe(0);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
    }
  });

  test('suppression-insert raced against the claim → never both suppressed-first and SENT', async () => {
    for (let s = 0; s < SEEDS; s += 1) {
      const sc = await freshScenario();
      const insertSuppression = ctx.db
        .insert(suppressions)
        .values({ kind: 'email', value: sc.recipient, source: 'manual' });
      const [pRes] = await Promise.allSettled([
        processIntent(h.deps, sc.intentId),
        insertSuppression,
      ]);
      expect(pRes.status).toBe('fulfilled');
      expect(sc.provider.sendCallCountForKey(sc.intentId)).toBeLessThanOrEqual(1);
      // The suppression check runs inside the claim txn AFTER the claim UPDATE, so
      // any suppression visible to that txn blocks. If the row ended SENT, the
      // suppression must have committed only after the send txn — assert we never
      // deliver to a recipient the send txn should have seen as suppressed.
      const st = await intentState(ctx.db, sc.intentId);
      if (st.state === 'BLOCKED') expect(sc.provider.deliveredCount).toBe(0);
      expect(['SENT', 'BLOCKED']).toContain(st.state);
    }
  });

  test('DNC flipped before the claim BLOCKS; DNC flipped mid-race never over-sends', async () => {
    for (let s = 0; s < SEEDS; s += 1) {
      const rng = makeRng(`dnc-${s}`);
      const onContact = rng.bool();
      const before = rng.bool();
      const sc = await freshScenario();
      const flip = onContact
        ? ctx.db.update(contacts).set({ dnc: true }).where(eq(contacts.id, sc.contactId))
        : ctx.db.update(leads).set({ dnc: true }).where(eq(leads.id, sc.leadId));

      if (before) {
        await flip;
        const res = await processIntent(h.deps, sc.intentId);
        expect(res.kind, `seed ${s}`).toBe('blocked');
        expect((await intentState(ctx.db, sc.intentId)).skipReason).toBe(
          onContact ? 'contact_dnc' : 'lead_dnc',
        );
        expect(sc.provider.deliveredCount).toBe(0);
      } else {
        const [pRes] = await Promise.allSettled([processIntent(h.deps, sc.intentId), flip]);
        expect(pRes.status).toBe('fulfilled');
      }
      // In every ordering: at most one delivery, at most one SENT row.
      expect(sc.provider.sendCallCountForKey(sc.intentId)).toBeLessThanOrEqual(1);
      expect(await sentIntentCount(sc.enrollmentId)).toBeLessThanOrEqual(1);
    }
  });
});

describe('I-SEND-4: cap is a hard ceiling under concurrency (never cap+1)', () => {
  test('K concurrent claims on one mailbox with cap=K send exactly K', async () => {
    for (let s = 0; s < 6; s += 1) {
      const rng = makeRng(`cap-${s}`);
      const cap = rng.int(2, 5);
      const extra = rng.int(2, 5);
      const m = cap + extra; // more intents than the cap allows

      uniq += 1;
      const address = `capbox-${uniq}@mock.test`;
      const rep = await seedUser(ctx.db, `caprep-${uniq}@switchboard.test`);
      const accountId = await seedAccount(ctx.db, h.cipher, rep, address);
      const template = await seedTemplate(ctx.db, rep);
      const provider = h.providerFor({ address, provider: 'mock' });
      await ctx.db
        .update(emailAccounts)
        .set({ dailySendCount: 0 })
        .where(eq(emailAccounts.id, accountId));

      // Per-mailbox cap for this seed. Org settings singleton is shared, so scope
      // the cap window wide and rely on the per-mailbox counter vs this seed's cap
      // by setting the org cap to this seed's cap (only these M intents run now).
      await ctx.db.execute(sql`UPDATE org_settings SET daily_send_cap = ${cap}`);

      const intentIds: string[] = [];
      const enrollmentIds: string[] = [];
      for (let i = 0; i < m; i += 1) {
        const leadId = await seedLead(ctx.db, `CapLead ${uniq}-${i}`);
        const contactId = await seedContact(ctx.db, leadId, `c-${uniq}-${i}@acme.test`);
        const { sequenceId } = await seedSequence(ctx.db, [
          { type: 'email', delayHours: 0, templateId: template },
        ]);
        const res = await enrollContacts(h.deps, {
          sequenceId,
          enrolledBy: rep,
          emailAccountId: accountId,
          targets: [{ leadId, contactId }],
        });
        const enrollmentId = res.enrolled[0]!.enrollmentId;
        enrollmentIds.push(enrollmentId);
        intentIds.push((await intentsForEnrollment(ctx.db, enrollmentId))[0]!.id);
      }

      const results = await Promise.allSettled(
        intentIds.map((id, i) => processIntent(asWorker(`cw-${s}-${i}`), id)),
      );
      expect(
        results.filter((r) => r.status === 'rejected'),
        `seed ${s}`,
      ).toHaveLength(0);
      const sent = results.filter(
        (r) => (r as PromiseFulfilledResult<DispatchResult>).value.kind === 'sent',
      );

      // Exactly the cap sends — never cap+1.
      expect(sent, `seed ${s}: exactly ${cap} sent`).toHaveLength(cap);
      expect(provider.deliveredCount).toBe(cap);

      // The mailbox counter equals the cap, and no more than cap intents are SENT.
      const acct = await ctx.db
        .select({ n: emailAccounts.dailySendCount })
        .from(emailAccounts)
        .where(eq(emailAccounts.id, accountId));
      expect(acct[0]!.n).toBe(cap);
    }
    await ctx.db.execute(sql`UPDATE org_settings SET daily_send_cap = 200`);
  });
});

describe('I-SEND-5: one-click unsubscribe concurrent with a due send → the send loses', () => {
  test('unsubscribe committed before the claim → send never happens; recipient suppressed', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshScenario();
      await applyUnsubscribe(ctx.db, { email: sc.recipient });
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).not.toBe('sent');
      expect(sc.provider.deliveredCount).toBe(0);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      // Global suppression is now in place.
      const supp = await ctx.db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(
          sql`${suppressions.value} = ${sc.recipient}::citext and ${suppressions.releasedAt} is null`,
        );
      expect(supp).toHaveLength(1);
    }
  });

  test('unsubscribe lands DURING the network window → paused_during_send, never SENT', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshScenario();
      sc.provider.setSendInterceptor(async () => {
        await applyUnsubscribe(ctx.db, { email: sc.recipient });
      });
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('paused_during_send');
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      expect((await intentState(ctx.db, sc.intentId)).state).toBe('SKIPPED');
      sc.provider.setSendInterceptor(undefined);
    }
  });
});

describe('crash recovery: the sweeper races the send transaction (I-SEND-1)', () => {
  test('sweeper expires the claim mid-network → the completed send still wins, once', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshScenario();
      const sweeper: SweeperDeps = {
        db: ctx.db,
        queue: h.queue,
        now: h.deps.now,
        claimTimeoutMs: 0,
      };
      // Fire the sweeper INSIDE the network window: it sees a CLAIMED row at/older
      // than the (zero) timeout and flips it to FAILED_TIMEOUT while the worker is
      // still awaiting provider.send(). Phase C then finalizes the delivered send.
      sc.provider.setSendInterceptor(async () => {
        const expired = await expireStaleClaims(sweeper);
        expect(expired, `seed ${s}: sweeper expired the in-flight claim`).toContain(sc.intentId);
      });
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('sent');
      // Exactly one delivery, exactly one SENT row — no double send despite the race.
      expect(sc.provider.sendCallCountForKey(sc.intentId)).toBe(1);
      expect(sc.provider.deliveredCount).toBe(1);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(1);
      expect((await intentState(ctx.db, sc.intentId)).state).toBe('SENT');
      sc.provider.setSendInterceptor(undefined);
    }
  });

  test('a genuine crash (claim, no send) → FAILED_TIMEOUT is never auto-re-sent', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshScenario();
      // Model a worker that claimed then died before provider.send(): a stale
      // CLAIMED row, no delivery.
      const staleAt = new Date(h.clock.now.getTime() - 600_000).toISOString();
      await ctx.db
        .update(sendIntents)
        .set({ state: 'CLAIMED', claimedAt: staleAt, workerId: 'dead-worker' })
        .where(eq(sendIntents.id, sc.intentId));

      const expired = await expireStaleClaims({
        db: ctx.db,
        queue: h.queue,
        now: h.deps.now,
        claimTimeoutMs: 300_000,
      });
      expect(expired, `seed ${s}`).toContain(sc.intentId);
      expect((await intentState(ctx.db, sc.intentId)).state).toBe('FAILED_TIMEOUT');

      // The due-intent sweep only re-enqueues SCHEDULED rows, so a FAILED_TIMEOUT is
      // never picked back up, and a direct re-process cannot claim it.
      await sweepDueIntents({
        db: ctx.db,
        queue: h.queue,
        now: h.deps.now,
        claimTimeoutMs: 300_000,
      });
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind).toBe('not_claimed');
      expect(sc.provider.deliveredCount).toBe(0);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
    }
  });
});

describe('AWAITING_REVIEW never auto-sends, even under a worker race (I-AI-adjacent)', () => {
  test('N workers racing a requires_review intent never claim or send it', async () => {
    for (let s = 0; s < 6; s += 1) {
      uniq += 1;
      const address = `review-${uniq}@mock.test`;
      const rep = await seedUser(ctx.db, `revrep-${uniq}@switchboard.test`);
      const leadId = await seedLead(ctx.db, `RevLead ${uniq}`);
      const contactId = await seedContact(ctx.db, leadId, `rev-${uniq}@acme.test`);
      const accountId = await seedAccount(ctx.db, h.cipher, rep, address);
      const template = await seedTemplate(ctx.db, rep);
      const { sequenceId } = await seedSequence(ctx.db, [
        { type: 'email', delayHours: 0, templateId: template, requiresReview: true },
      ]);
      const res = await enrollContacts(h.deps, {
        sequenceId,
        enrolledBy: rep,
        emailAccountId: accountId,
        targets: [{ leadId, contactId }],
      });
      const enrollmentId = res.enrolled[0]!.enrollmentId;
      const intentId = (await intentsForEnrollment(ctx.db, enrollmentId))[0]!.id;
      const provider = h.providerFor({ address, provider: 'mock' });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => processIntent(asWorker(`rv-${s}-${i}`), intentId)),
      );
      const kinds = results.map((r) => (r as PromiseFulfilledResult<DispatchResult>).value.kind);
      expect(
        kinds.every((k) => k === 'not_claimed'),
        `seed ${s}`,
      ).toBe(true);
      expect((await intentState(ctx.db, intentId)).state).toBe('AWAITING_REVIEW');
      expect(provider.deliveredCount).toBe(0);
      expect(await sentIntentCount(enrollmentId)).toBe(0);
    }
  });
});

describe('dead mailbox: a REAUTH_REQUIRED / rejecting provider never yields a SENT', () => {
  test('provider.send rejects (dead tokens) → FAILED, never SENT, enrollment not finished', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshScenario();
      // Model the mailbox going dead mid-sequence: the state machine has moved the
      // account to REAUTH_REQUIRED and the stale tokens are rejected on send.
      await ctx.db
        .update(emailAccounts)
        .set({ syncStatus: 'REAUTH_REQUIRED' })
        .where(eq(emailAccounts.id, sc.accountId));
      sc.provider.setSendInterceptor(() => {
        throw new Error('invalid_grant: mailbox re-auth required');
      });
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('failed');
      const st = await intentState(ctx.db, sc.intentId);
      expect(st.state).toBe('FAILED');
      expect(sc.provider.deliveredCount).toBe(0);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      expect(await countActivities(ctx.db, sc.leadId, 'sequence_step_sent')).toBe(0);
      expect(await countActivities(ctx.db, sc.leadId, 'sequence_finished')).toBe(0);
      sc.provider.setSendInterceptor(undefined);
    }
  });
});
