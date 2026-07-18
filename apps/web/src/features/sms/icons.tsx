import type { JSX, ReactNode } from 'react';

/*
 * Feature-local line glyphs at the Operator Grid's canonical 1.5 stroke width
 * (24×24, round caps/joins, currentColor) — the same convention as the comms and
 * leads icon sets, so state color flows from the parent. Decorative by default;
 * pass `title` to promote to an accessible img.
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

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m5 12 5 5L20 7" />
    </Icon>
  );
}

export function CheckCheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m1 13 4 4L15 7" />
      <path d="m11 13 1 1 8-8" />
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

export function BanIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </Icon>
  );
}

export function PhoneOffIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10.7 5.5a2 2 0 0 1 1.4-.5h3a2 2 0 0 1 2 1.72c.1.72.27 1.43.5 2.1a2 2 0 0 1-.45 2.1l-1 1" />
      <path d="M8 8a16 16 0 0 0 6 6l.3-.3" />
      <path d="M6.5 3.9A2 2 0 0 1 8 5.72c.06.44.16.88.28 1.3" />
      <path d="M2 2l20 20" />
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

export function TemplateIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M8 13h8M8 17h5" />
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

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </Icon>
  );
}
