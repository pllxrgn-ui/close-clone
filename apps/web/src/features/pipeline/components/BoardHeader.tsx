import type { JSX } from 'react';
import { KanbanIcon } from '../icons.tsx';
import { MoneySums } from './MoneySums.tsx';
import type { CurrencySum } from '../lib/money.ts';

/*
 * Board header: the two figures that summarize the whole board — open pipeline
 * (sum of active deals) and confidence-weighted pipeline — as big display
 * numerals, one per currency. Deal count rounds it out.
 */

interface BoardHeaderProps {
  totals: CurrencySum[];
  weightedTotals: CurrencySum[];
  dealCount: number;
}

export function BoardHeader({ totals, weightedTotals, dealCount }: BoardHeaderProps): JSX.Element {
  return (
    <header className="pl-header">
      <div className="pl-header__title">
        <KanbanIcon size={20} className="pl-header__icon" />
        <h1 className="pl-header__h1">Pipeline</h1>
        <span className="pl-header__count" aria-live="polite">
          {dealCount.toLocaleString('en-US')} {dealCount === 1 ? 'deal' : 'deals'}
        </span>
      </div>

      <dl className="pl-header__metrics">
        <div className="pl-metric">
          <dt className="pl-metric__label">Open pipeline</dt>
          <dd className="pl-metric__value">
            <MoneySums sums={totals} emptyLabel="$0" />
          </dd>
        </div>
        <div className="pl-metric">
          <dt className="pl-metric__label">Weighted</dt>
          <dd className="pl-metric__value pl-metric__value--dim">
            <MoneySums sums={weightedTotals} emptyLabel="$0" />
          </dd>
        </div>
      </dl>
    </header>
  );
}
