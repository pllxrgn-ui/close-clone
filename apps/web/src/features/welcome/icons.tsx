import type { JSX, ReactNode } from 'react';

/*
 * Welcome-local line icons. W1 deliberately ships no icon dependency
 * (ui/icons.tsx: "no icon dependency, no CDN"), so rather than pull in
 * lucide-react we inline the few glyphs this page needs using lucide's
 * canonical path data at the law's stroke width (1.5). viewBox/appearance match
 * ui/icons.tsx so reused and local icons read as one set.
 */

export interface WelcomeIconProps {
  size?: number;
  className?: string;
}

function Glyph({
  size = 16,
  className,
  children,
}: WelcomeIconProps & { children: ReactNode }): JSX.Element {
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
      {children}
    </svg>
  );
}

/** The wordmark glyph — a patch panel of jacks (a switchboard). */
export function BoardMark({ size = 20, className }: WelcomeIconProps): JSX.Element {
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

/** Phone handset (lucide "phone"). */
export function PhoneIcon(props: WelcomeIconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </Glyph>
  );
}

/** Repeat / cadence (lucide "repeat"). */
export function RepeatIcon(props: WelcomeIconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </Glyph>
  );
}

/** Check (lucide "check") — used on the consent line. */
export function CheckIcon(props: WelcomeIconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}
