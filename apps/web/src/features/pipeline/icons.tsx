import type { JSX, ReactNode } from 'react';

/*
 * Feature-local icon set — hand-rolled line glyphs at the LAW's canonical 1.5
 * stroke, matching the leads feature's approach (swappable for lucide-react
 * one-for-one at merge). 24×24 viewBox, round caps/joins, `currentColor` stroke
 * so state color flows from the parent. Decorative by default (aria-hidden);
 * pass `title` to promote to an `img` with an accessible name.
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

/** Kanban board — the nav + surface glyph: a frame with three lane bars. */
export function KanbanIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M8 7v8M12 7v4M16 7v6" />
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

/** Six-dot drag affordance. */
export function GripIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </Icon>
  );
}

export function TrophyIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 9a6 6 0 0 0 12 0V4H6Z" />
      <path d="M6 5H3v1a3 3 0 0 0 3 3M18 5h3v1a3 3 0 0 1-3 3" />
      <path d="M9 21h6M12 15v6" />
    </Icon>
  );
}

export function BanIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </Icon>
  );
}
