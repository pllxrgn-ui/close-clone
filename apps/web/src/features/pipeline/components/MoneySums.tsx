import type { JSX } from 'react';
import { cx } from '../../../lib/cx.ts';
import { formatMoney } from '../lib/money.ts';
import type { CurrencySum } from '../lib/money.ts';

/*
 * Renders a set of per-currency subtotals. Currencies are never summed together,
 * so each appears as its own display numeral; the full (uncompacted) amount is
 * on the title for hover. One figure → reads as a single number; many → a small
 * stack, which is the visible signal that a column mixes currencies.
 */

interface MoneySumsProps {
  sums: CurrencySum[];
  compact?: boolean;
  className?: string;
  emptyLabel?: string;
}

export function MoneySums({
  sums,
  compact = true,
  className,
  emptyLabel = '—',
}: MoneySumsProps): JSX.Element {
  if (sums.length === 0) {
    return <span className={cx('pl-money', 'pl-money--empty', className)}>{emptyLabel}</span>;
  }
  return (
    <span className={cx('pl-money-set', className)}>
      {sums.map((sum) => (
        <span
          key={sum.currency}
          className="pl-money"
          title={`${formatMoney(sum.cents, sum.currency, { compact: false })} ${sum.currency}`}
        >
          {formatMoney(sum.cents, sum.currency, { compact })}
        </span>
      ))}
    </span>
  );
}
