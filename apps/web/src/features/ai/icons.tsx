import type { JSX, ReactNode } from 'react';

/*
 * Feature-local line glyphs at the Operator Grid's canonical 1.5 stroke width (same
 * convention as features/comms + features/leads: 24×24, round caps/joins,
 * currentColor so state color flows from the parent; decorative by default, pass
 * `title` to promote to an accessible img). Swappable for lucide-react at merge
 * without touching call sites.
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

/** The AI marker (lucide Sparkles). */
export function SparklesIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0Z" />
      <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </Icon>
  );
}

/** Rewrite / regenerate (a counter-clockwise refresh). */
export function RewriteIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </Icon>
  );
}

export function PhoneIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.09 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m5 12 5 5L20 7" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function AlertTriangleIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </Icon>
  );
}

/** A note / document (the summary artifact). */
export function NoteIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M8 13h8M8 17h5" />
    </Icon>
  );
}
