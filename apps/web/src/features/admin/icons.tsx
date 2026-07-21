import type { JSX } from 'react';
import {
  ArrowLeft,
  Ban,
  Calendar,
  Check,
  ChevronRight,
  CircleDot,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Hash,
  Info,
  ListChecks,
  Lock,
  Mail,
  Pencil,
  Plus,
  ShieldCheck,
  Signature,
  SlidersHorizontal,
  Tag,
  Target,
  TriangleAlert,
  Type,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/*
 * Admin-feature icon set — lucide-react at the Operator Grid's law stroke weight
 * of 1.5. Same contract as ui/icons.tsx: decorative by default (aria-hidden), or
 * pass `title` to promote to an img with an accessible name.
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

// Bulk actions
export const AssignOwnerIcon = toIcon(UserPlus);
export const StatusIcon = toIcon(Target);
export const SequenceIcon = toIcon(GitBranch);
export const ExportIcon = toIcon(Download);
export const DncIcon = toIcon(Ban);
export const DncClearIcon = toIcon(ShieldCheck);

// Settings nav + sections
export const UsersIcon = toIcon(Users);
export const CustomFieldsIcon = toIcon(SlidersHorizontal);
export const TemplatesIcon = toIcon(FileText);
export const ComplianceIcon = toIcon(ShieldCheck);
export const AboutIcon = toIcon(Info);
export const InboxesIcon = toIcon(Mail);

// Field-type + misc glyphs
export const TypeTextIcon = toIcon(Type);
export const TypeNumberIcon = toIcon(Hash);
export const TypeDateIcon = toIcon(Calendar);
export const TypeSelectIcon = toIcon(ListChecks);
export const TypeUserIcon = toIcon(Users);
export const TagIcon = toIcon(Tag);
export const PlusIcon = toIcon(Plus);
export const CheckIcon = toIcon(Check);
export const ChevronRightIcon = toIcon(ChevronRight);
export const PencilIcon = toIcon(Pencil);
export const ExternalLinkIcon = toIcon(ExternalLink);
export const LockIcon = toIcon(Lock);
export const WarnIcon = toIcon(TriangleAlert);
export const SignatureIcon = toIcon(Signature);
export const DotIcon = toIcon(CircleDot);
export const BackIcon = toIcon(ArrowLeft);
export const XIcon = toIcon(X);
