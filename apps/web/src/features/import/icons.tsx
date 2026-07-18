import type { JSX } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CloudUpload,
  Download,
  FileSpreadsheet,
  Info,
  ListChecks,
  RotateCcw,
  Table2,
  Trash2,
} from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/*
 * Import-feature icon set — lucide-react at the Operator Grid's fixed 1.5 stroke
 * (DESIGN §6). Same decorative-by-default contract as ui/icons.tsx: pass `title`
 * to promote an icon to an accessible image.
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

export const UploadIcon = toIcon(CloudUpload);
export const FileCsvIcon = toIcon(FileSpreadsheet);
export const MapIcon = toIcon(Table2);
export const PreviewIcon = toIcon(ListChecks);
export const DoneIcon = toIcon(CircleCheck);
export const ArrowRightIcon = toIcon(ArrowRight);
export const ArrowLeftIcon = toIcon(ArrowLeft);
export const ResetIcon = toIcon(RotateCcw);
export const DownloadIcon = toIcon(Download);
export const RemoveIcon = toIcon(Trash2);
export const InfoIcon = toIcon(Info);
export const AlertIcon = toIcon(CircleAlert);
