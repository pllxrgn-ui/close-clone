import type { JSX } from 'react';
import { Button } from '../../../ui/index.ts';
import { useComms } from '../context/CommsProvider.tsx';
import { MailIcon } from '../icons.tsx';

/*
 * The lead-page next-action seam. Mounted at merge into the LeadHeader action bar
 * (replacing the disabled "Email" placeholder) — see routeWiring. Pointer-opens
 * the composer for this lead (animated entrance), pre-seeding recipient/merge
 * context from the lead-detail store the composer fetches by leadId.
 */
export function LeadComposerLauncher({ leadId }: { leadId: string }): JSX.Element {
  const { openComposer } = useComms();
  return (
    <Button size="sm" onClick={() => openComposer({ leadId, origin: 'pointer' })}>
      <MailIcon size={14} /> Email
    </Button>
  );
}
