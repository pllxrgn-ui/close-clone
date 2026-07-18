import type { JSX } from 'react';
import { StatusPill, type StatusTone } from '../../../ui/index.ts';
import { matchTypeLabel, outcomeLabel } from '../lib/format.ts';
import type { MatchType, RowOutcome } from '../types.ts';

/*
 * The ledger's per-row disposition badge. Color is the state budget only
 * (DESIGN §2): create = reply-green (a new record), duplicate = seq-purple
 * (linked to something we already have), error = dnc-red, empty = achromatic.
 */
const TONE: Record<RowOutcome, StatusTone> = {
  create: 'newReply',
  dedupe: 'inSequence',
  error: 'dnc',
  empty: 'neutral',
};

export interface DispositionPillProps {
  outcome: RowOutcome;
  matchType: MatchType | null;
}

export function DispositionPill({ outcome, matchType }: DispositionPillProps): JSX.Element {
  const label =
    outcome === 'dedupe' && matchType !== null
      ? `${outcomeLabel(outcome)} · ${matchTypeLabel(matchType)}`
      : outcomeLabel(outcome);
  return (
    <StatusPill tone={TONE[outcome]} dot>
      {label}
    </StatusPill>
  );
}
