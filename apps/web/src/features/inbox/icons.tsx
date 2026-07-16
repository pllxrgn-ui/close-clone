import type { JSX, ReactNode } from 'react';

/*
 * Feature-local icon set — lucide-style line glyphs at the LAW's canonical 1.5
 * stroke width, 24×24 viewBox, round caps/joins, `currentColor` stroke so state
 * color flows from the parent. Decorative by default (aria-hidden); pass `title`
 * to promote one to an `img` with an accessible name. Mirrors the pattern used by
 * the leads/welcome features (one-for-one swappable with lucide-react at merge).
 */

export interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

function Icon({
  children,
  size = 16,
  className,
  title,
}: IconProps & { children: ReactNode }): JSX.Element {
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
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Reply — corner arrow turning back up-left. */
export function ReplyIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 17 4 12l5-5" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </Icon>
  );
}

export function MailIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </Icon>
  );
}

/** SMS / chat bubble. */
export function MessageIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </Icon>
  );
}

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </Icon>
  );
}

/** Complete / approve check. */
export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m5 12 5 5L20 7" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

/** Sequence branch. */
export function BranchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M8.4 7.2A6 6 0 0 1 15.5 9" />
    </Icon>
  );
}

/** Snooze — a moon (until tomorrow). */
export function SnoozeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </Icon>
  );
}

/** Skip — skip-forward. */
export function SkipIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 5v14l9-7-9-7Z" />
      <path d="M19 5v14" />
    </Icon>
  );
}

export function XIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

/** Inbox — used in the zero state. */
export function InboxIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 13h4l2 3h4l2-3h4" />
      <path d="M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
    </Icon>
  );
}

/** Zero-inbox mark — a calm checked circle. */
export function InboxZeroIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Icon>
  );
}
