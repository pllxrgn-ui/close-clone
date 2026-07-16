import type { JSX, ReactNode } from 'react';

/*
 * Feature-local line glyphs at the Operator Grid's canonical 1.5 stroke width.
 * Same convention as the leads feature's icon set (24×24, round caps/joins,
 * currentColor) so state color flows from the parent; decorative by default,
 * pass `title` to promote to an accessible img. Swappable for lucide-react at
 * merge without touching call sites.
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

export function MailIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
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

export function PhoneIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.09 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </Icon>
  );
}

export function MessageIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
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

export function PauseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 4H6v16h3zM18 4h-3v16h3z" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 3.5v17l14-8.5Z" />
    </Icon>
  );
}

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

export function BanIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </Icon>
  );
}

export function ShieldCheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function ReplyIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 17H7a4 4 0 0 1-4-4 4 4 0 0 1 4-4h13" />
      <path d="m8 5-5 4 5 4" />
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

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
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

export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
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

export function UserPlusIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 21a7 7 0 0 1 12 0" />
      <path d="M18 8v6M21 11h-6" />
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

export function SlashIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 15.5 15.5 8.5" />
    </Icon>
  );
}

export function ArchiveIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </Icon>
  );
}
