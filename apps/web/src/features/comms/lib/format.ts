/*
 * Small formatting helpers for the comms surfaces. Pure and locale-stable so the
 * step ladder ("Immediately", "2 days") and enrollment rows read the same in every
 * environment. Kept feature-local to avoid coupling to another feature's lib.
 */

/** Human phrasing for a step delay in hours: 0 → "Immediately", else days/hours. */
export function formatDelay(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'Immediately';
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (rem > 0) parts.push(`${rem} hour${rem === 1 ? '' : 's'}`);
  return parts.join(' ') || 'Immediately';
}

/** Channel label for a sequence-step type. */
export function channelLabel(type: 'email' | 'call_task' | 'sms'): string {
  switch (type) {
    case 'email':
      return 'Email';
    case 'call_task':
      return 'Call task';
    case 'sms':
      return 'SMS';
  }
}

/** Compact relative time ("just now", "3h ago", "2d ago") from an ISO string. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const deltaMs = now.getTime() - then;
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
