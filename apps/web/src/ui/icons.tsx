import type { JSX } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
  Command,
  CornerDownLeft,
  Inbox,
  KeyRound,
  LifeBuoy,
  ListFilter,
  Minus,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
  TriangleAlert,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/*
 * Icon set — lucide-react at the Operator Grid's fixed 1.5 stroke weight (law).
 * Each export is a thin wrapper that preserves the app's icon contract:
 *   - decorative by default (aria-hidden, not focusable)
 *   - pass `title` to promote it to an img with an accessible name
 * so no call site changes when the underlying glyph is a lucide component.
 */

export interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

function toIcon(Glyph: LucideIcon): (props: IconProps) => JSX.Element {
  function Icon({ size = 16, className, title }: IconProps): JSX.Element {
    const a11y: LucideProps = title
      ? { role: 'img', 'aria-label': title }
      : { 'aria-hidden': true, focusable: false };
    return <Glyph size={size} strokeWidth={1.5} className={className} {...a11y} />;
  }
  return Icon;
}

export const InboxIcon = toIcon(Inbox);
export const LeadsIcon = toIcon(Users);
export const ViewsIcon = toIcon(ListFilter);
export const ReportsIcon = toIcon(BarChart3);
export const SettingsIcon = toIcon(Settings);
export const SearchIcon = toIcon(Search);
export const ChevronDownIcon = toIcon(ChevronDown);
export const SunIcon = toIcon(Sun);
export const MoonIcon = toIcon(Moon);
export const MonitorIcon = toIcon(Monitor);
export const BoltIcon = toIcon(Zap);
export const CloseIcon = toIcon(X);
export const CommandIcon = toIcon(Command);
export const CornerDownLeftIcon = toIcon(CornerDownLeft);
export const KeyIcon = toIcon(KeyRound);
export const CheckIcon = toIcon(Check);
export const MinusIcon = toIcon(Minus);
export const AlertTriangleIcon = toIcon(TriangleAlert);
export const EllipsisIcon = toIcon(MoreHorizontal);
export const SupportIcon = toIcon(LifeBuoy);
export const PanelLeftCloseIcon = toIcon(PanelLeftClose);
export const PanelLeftOpenIcon = toIcon(PanelLeftOpen);
