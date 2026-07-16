import type { JSX, ReactNode } from 'react';

/*
 * Feature-local icon set — hand-rolled, lucide-style line glyphs at the LAW's
 * canonical stroke width of 1.5 (the W1 `ui/icons.tsx` set ships at 1.75 and is
 * owned by the foundation/re-skin track; this set is swappable for `lucide-react`
 * one-for-one at merge without touching call sites). 24×24 viewBox, round caps
 * and joins, `currentColor` stroke so state color flows from the parent.
 *
 * Icons are decorative by default (aria-hidden); pass `title` to promote one to
 * an `img` with an accessible name.
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

// ── Timeline / C4 activity glyphs ───────────────────────────────────────────

export function PhoneIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.09 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </Icon>
  );
}

export function PhoneMissedIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m16 3 5 5M21 3l-5 5" />
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.09 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </Icon>
  );
}

export function VoicemailIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="6" cy="12" r="4" />
      <circle cx="18" cy="12" r="4" />
      <path d="M6 16h12" />
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

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </Icon>
  );
}

export function MailXIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 8.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9" />
      <path d="m2 7 10 6 5-3" />
      <path d="m17 16 5 5M22 16l-5 5" />
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

export function MessageOffIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </Icon>
  );
}

export function NoteIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Z" />
      <path d="M14 21v-5a2 2 0 0 1 2-2h5" />
    </Icon>
  );
}

export function CircleDashedIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10.1 2.2a10 10 0 0 1 3.8 0" />
      <path d="M18 3.9a10 10 0 0 1 2.1 2.1" />
      <path d="M21.8 10.1a10 10 0 0 1 0 3.8" />
      <path d="M20.1 18a10 10 0 0 1-2.1 2.1" />
      <path d="M13.9 21.8a10 10 0 0 1-3.8 0" />
      <path d="M6 20.1A10 10 0 0 1 3.9 18" />
      <path d="M2.2 13.9a10 10 0 0 1 0-3.8" />
      <path d="M3.9 6A10 10 0 0 1 6 3.9" />
    </Icon>
  );
}

export function CheckCircleIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Icon>
  );
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  );
}

export function HistoryIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

export function ArrowRightCircleIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8M13 8l4 4-4 4" />
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

export function TargetIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
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

export function PauseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 9v6M14 9v6" />
    </Icon>
  );
}

export function FlagIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 8 2a6 6 0 0 0 3-.8V13a6 6 0 0 1-3 .8c-3 0-5-2-8-2a6 6 0 0 0-4 1" />
    </Icon>
  );
}

export function SparkleIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />
      <path d="m6.5 6.5 2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5" />
    </Icon>
  );
}

export function MergeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M6 8.5v7M8.3 7.4A6 6 0 0 0 15.5 12" />
    </Icon>
  );
}

export function UploadIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M12 15V3M7 8l5-5 5 5" />
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

export function MicIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
    </Icon>
  );
}

export function UserXIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 21a7 7 0 0 1 12 0" />
      <path d="m17 8 4 4M21 8l-4 4" />
    </Icon>
  );
}

// ── Chrome glyphs ───────────────────────────────────────────────────────────

export function ChevronUpIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m6 15 6-6 6 6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
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

export function FilterIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 5h16M7 12h10M10 19h4" />
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

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m5 12 5 5L20 7" />
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

export function UsersIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6a3 3 0 0 1 0 6M17 14a5.5 5.5 0 0 1 3.5 5" />
    </Icon>
  );
}

export function BriefcaseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M2 12h20" />
    </Icon>
  );
}

export function DollarIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 2v20M17 6.5A4 4 0 0 0 13 4h-2a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-2a4 4 0 0 1-4-2.5" />
    </Icon>
  );
}

export function ExternalLinkIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15 3h6v6M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
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

export function InboxIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 13h4l2 3h4l2-3h4" />
      <path d="M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
    </Icon>
  );
}
