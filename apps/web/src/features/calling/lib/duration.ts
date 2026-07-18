/*
 * Call-duration formatting. A live call timer shows `m:ss` under an hour and
 * `h:mm:ss` past it; digits are meant to sit in a tabular-nums cell so the
 * width never jitters as it ticks. Pure + deterministic (no clock inside), so
 * the strip owns the tick and this owns the shape.
 */

/** Format elapsed whole seconds as `m:ss` (or `h:mm:ss` at/past one hour). */
export function formatCallDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** Elapsed whole seconds between two epoch-ms marks (clamped at zero). */
export function elapsedSeconds(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 1000));
}
