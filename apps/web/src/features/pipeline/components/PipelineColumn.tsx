import type { JSX, ReactNode } from 'react';
import { cx } from '../../../lib/cx.ts';
import { formatMoney } from '../lib/money.ts';
import { BanIcon, KanbanIcon, TrophyIcon } from '../icons.tsx';
import { MoneySums } from './MoneySums.tsx';
import type { ColumnVM } from '../model/board.ts';

/*
 * A stage column: header (name + count + per-currency subtotal), the card list,
 * and — when empty — a quiet dashed drop target rather than blank space. The
 * `data-stage-id` on the section is what pointer-drag hit-tests against to find
 * the drop target. Terminal columns carry a won/lost glyph.
 */

interface PipelineColumnProps {
  column: ColumnVM;
  isDropTarget: boolean;
  children: ReactNode;
  cardCount: number;
}

function accessibleName(column: ColumnVM): string {
  const money =
    column.sums.length > 0
      ? column.sums.map((s) => formatMoney(s.cents, s.currency, { compact: false })).join(', ')
      : 'no value';
  const deals = `${column.count} ${column.count === 1 ? 'deal' : 'deals'}`;
  return `${column.stage.label}, ${deals}, ${money}`;
}

export function PipelineColumn({
  column,
  isDropTarget,
  children,
  cardCount,
}: PipelineColumnProps): JSX.Element {
  const terminalIcon =
    column.terminal === 'won' ? (
      <TrophyIcon size={13} className="pl-col__terminal-icon" />
    ) : column.terminal === 'lost' ? (
      <BanIcon size={13} className="pl-col__terminal-icon" />
    ) : null;

  return (
    <section
      className={cx(
        'pl-col',
        column.terminal && `pl-col--${column.terminal}`,
        isDropTarget && 'is-drop-target',
      )}
      data-stage-id={column.stage.id}
      aria-label={accessibleName(column)}
    >
      <header className="pl-col__head">
        <span className="pl-col__name">
          {terminalIcon}
          {column.stage.label}
        </span>
        <span className="pl-col__count" aria-hidden="true">
          {column.count}
        </span>
        <MoneySums sums={column.sums} className="pl-col__sums" />
      </header>

      <ul className="pl-col__cards" role="list">
        {children}
      </ul>

      {cardCount === 0 ? (
        <div className="pl-col__empty" aria-hidden="true">
          <KanbanIcon size={18} />
          <span>Drop a deal here</span>
        </div>
      ) : null}
    </section>
  );
}
