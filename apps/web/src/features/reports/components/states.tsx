/*
 * Shared load / error states for the report panels. Skeletons are decorative
 * (aria-hidden) and paired with an aria-busy region; the error note offers a real
 * re-query (Retry), never a dead end.
 */
import type { JSX } from 'react';
import { ErrorState, Skeleton } from '../../../ui/index.ts';

/** A row of stat-tile placeholders. */
export function TilesSkeleton({ count = 5 }: { count?: number }): JSX.Element {
  return (
    <div className="rpt-skel-tiles" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="rpt-skel-tile" key={i}>
          <Skeleton width="60%" height={24} />
          <Skeleton width="45%" height={9} />
        </div>
      ))}
    </div>
  );
}

/** A stack of row placeholders for a table/chart card. */
export function RowsSkeleton({ count = 5 }: { count?: number }): JSX.Element {
  return (
    <div className="rpt-skel-rows" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} width={`${90 - i * 8}%`} height={16} />
      ))}
    </div>
  );
}

/** Failed-to-load pane with a Retry that re-runs the query. */
export function ReportError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return <ErrorState title="Couldn’t load this report" description={message} onRetry={onRetry} />;
}
