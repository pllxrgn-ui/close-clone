import type { Lead, Opportunity, OpportunityStage } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { sortStages, statusForStage, terminalKind } from '../lib/stages.ts';

/*
 * The board's demo seed, derived read-only from the shared fixture `db`.
 *
 * The fixture assigns opportunity stages uniformly and prices everything in USD.
 * A pipeline board needs more: a funnel-shaped stage distribution, a mix of
 * currencies (so the "never sum across currencies" rule is visible), coherent
 * status (a card in a terminal column IS won/lost), and a few overdue close
 * dates (so the amber past-due treatment shows). We keep each deal's real
 * identity — id, lead, value, owner — and only reshape those presentation-facing
 * fields. Everything is a pure function of the deal id, so the seed is
 * byte-identical on every load, exactly like the fixture it derives from.
 */

// Fixed anchor (the fixture's reference "now") so close dates are deterministic.
const ANCHOR_UTC = Date.UTC(2026, 6, 15); // 2026-07-15
const DAY_MS = 86_400_000;

// Funnel weighting across stages in display order; most deals sit early, few are
// closed. Used only when there are exactly five stages (the standard board).
const FUNNEL_WEIGHTS = [0.3, 0.26, 0.22, 0.12, 0.1] as const;

/** Stable FNV-1a hash of a string → a value in [0, 1). */
function hash01(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

function isoDatePlusDays(days: number): string {
  return new Date(ANCHOR_UTC + days * DAY_MS).toISOString().slice(0, 10);
}

function currencyForRegion(region: unknown): string {
  if (region === 'EMEA') return 'EUR';
  if (region === 'APAC') return 'AUD';
  return 'USD';
}

function pickStageIndex(r: number, count: number): number {
  if (count === FUNNEL_WEIGHTS.length) {
    let acc = 0;
    for (let i = 0; i < FUNNEL_WEIGHTS.length; i += 1) {
      acc += FUNNEL_WEIGHTS[i] ?? 0;
      if (r < acc) return i;
    }
    return count - 1;
  }
  return Math.min(count - 1, Math.floor(r * count));
}

function closeDateFor(r: number, isTerminal: boolean): string {
  // Terminal deals closed in the recent past; open deals span roughly -20..+69
  // days from the anchor, so a realistic minority is already overdue (amber).
  const days = isTerminal ? -3 - Math.floor(r * 57) : Math.floor(r * 90) - 20;
  return isoDatePlusDays(days);
}

/** Build the board seed from the fixture. Deterministic. */
export function buildPipelineSeed(): {
  opportunities: Opportunity[];
  stages: OpportunityStage[];
} {
  const stages = sortStages(db.opportunityStages);
  const leadById = new Map<string, Lead>(db.leads.map((lead) => [lead.id, lead]));

  const opportunities = db.opportunities.map((base): Opportunity => {
    const lead = leadById.get(base.leadId);
    const region = lead?.custom.region;
    const stage = stages[pickStageIndex(hash01(`${base.id}:stage`), stages.length)];
    const status = stage ? statusForStage(stage) : 'active';
    const isTerminal = stage ? terminalKind(stage) !== null : false;

    return {
      ...base,
      stageId: stage?.id ?? base.stageId,
      currency: currencyForRegion(region),
      status,
      // Won deals read as 100% likely, lost as 0%, open deals keep their estimate.
      confidence: status === 'won' ? 100 : status === 'lost' ? 0 : base.confidence,
      closeDate: closeDateFor(hash01(`${base.id}:date`), isTerminal),
    };
  });

  return { opportunities, stages };
}
