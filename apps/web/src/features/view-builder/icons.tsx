import type { JSX, ReactNode } from 'react';

/*
 * Local inline icon set for the builder. The Operator Grid design law mandates
 * lucide-react geometry at stroke 1.5; the committed W1 `ui/icons.tsx` is stroke
 * 1.75 and is owned by another sprint task, so these live here at the correct
 * 1.5 weight (paths trace the lucide originals). Decorative by default.
 */
interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ children, size = 16, className }: IconProps & { children: ReactNode }): JSX.Element {
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

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function GroupIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2" />
    </Svg>
  );
}

export function ArrowUpIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </Svg>
  );
}

export function ArrowDownIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function XIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </Svg>
  );
}
