import type { JSX } from 'react';

/**
 * The Switchboard brand glyph — a patch panel of jacks. ONE mark everywhere:
 * the landing wordmark and the app top bar render this same component
 * (promoted from features/welcome so the shell never re-invents the logo).
 * Decorative (aria-hidden); pair it with visible wordmark text.
 */
export function BoardMark({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8" cy="9" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="9" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="16" cy="9" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="15" r="1.15" />
      <circle cx="12" cy="15" r="1.15" />
      <circle cx="16" cy="15" r="1.15" />
    </svg>
  );
}
