import type { JSX } from 'react';
import { Button } from '../../../ui/index.ts';
import { useSms } from '../context/SmsProvider.tsx';
import { MessageIcon } from '../icons.tsx';

/*
 * The lead-page next-action seam. Mounted at merge into the LeadHeader action bar,
 * REPLACING the disabled "SMS" placeholder (see routeWiring). Pointer-opens the SMS
 * conversation drawer for this lead (animated entrance); the drawer fetches the
 * thread + contacts by leadId and enforces every compliance rail before Send.
 */
export function LeadSmsLauncher({ leadId }: { leadId: string }): JSX.Element {
  const { openThread } = useSms();
  return (
    <Button size="sm" onClick={() => openThread({ leadId, origin: 'pointer' })}>
      <MessageIcon size={14} /> SMS
    </Button>
  );
}
