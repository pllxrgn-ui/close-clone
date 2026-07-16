import type { JSX } from 'react';
import { cx } from '../../../lib/cx.ts';
import type { MergeSegment } from '../lib/mergeTags.ts';

/*
 * Renders resolved template text with each unresolved `{{tag}}` shown as a
 * visible amber (draft-state) token. The composer gates Send while any of these
 * are present, so an unresolved tag is always visible before it could ship.
 * `pre-wrap` (in comms.css) preserves the template's line breaks.
 */
export function MergePreview({
  segments,
  className,
}: {
  segments: MergeSegment[];
  className?: string;
}): JSX.Element {
  return (
    <div className={cx('comms-preview', className)}>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return <span key={i}>{seg.value}</span>;
        }
        if (seg.resolved) {
          return (
            <span key={i} className="comms-preview__resolved">
              {seg.value}
            </span>
          );
        }
        return (
          <mark key={i} className="comms-preview__unresolved" title={`Unresolved: ${seg.key}`}>
            {seg.raw}
          </mark>
        );
      })}
    </div>
  );
}
