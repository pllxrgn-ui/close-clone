import type { JSX, ReactNode } from 'react';

/*
 * Feature-local line glyphs at the Operator Grid's canonical 1.5 stroke width —
 * same convention as the comms/leads icon sets (24×24, round caps/joins,
 * currentColor so state color flows from the parent; decorative by default,
 * pass `title` to promote to an accessible img). Path data tracks lucide so a
 * swap to lucide-react at merge needs no call-site change.
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

export function PhoneIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.09 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </Icon>
  );
}

export function PhoneOffIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.8 12.8 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.4 19.4 0 0 1-3.33-2.67m-2.67-3.34a19.8 19.8 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" />
      <path d="m2 2 20 20" />
    </Icon>
  );
}

/** Active outbound call (handset + up-right arrow). */
export function PhoneOutgoingIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.09 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
      <path d="M15 7h6v6M21 7l-7 7" />
    </Icon>
  );
}

export function MicIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
    </Icon>
  );
}

export function MicOffIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 9v1a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M5 10a7 7 0 0 0 10.7 5.98M19 10a6.9 6.9 0 0 1-.7 3M12 17v4" />
      <path d="m2 2 20 20" />
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

export function VoicemailIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="6" cy="12" r="4" />
      <circle cx="18" cy="12" r="4" />
      <path d="M6 16h12" />
    </Icon>
  );
}

export function SkipForwardIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 4.5v15l11-7.5Z" />
      <path d="M19 5v14" />
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

export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

/** Solid recording dot (filled, not stroked) for the REC indicator. */
export function RecordDotIcon({ size = 10, className, title }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}
