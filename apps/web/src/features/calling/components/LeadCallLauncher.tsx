import { useEffect } from 'react';
import type { JSX } from 'react';
import type { Lead } from '@switchboard/shared';
import { Button } from '../../../ui/index.ts';
import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';
import { useCall } from '../context/CallProvider.tsx';
import { PhoneIcon } from '../icons.tsx';

/*
 * The lead-page next-action seam. Mounted at merge into the LeadHeader action bar
 * (replacing the disabled "Call" placeholder) — see routeWiring. Clicking dials
 * the lead's primary phone through the compliance-gated engine; the global call
 * strip (mounted by CallProvider) then owns the live call. It also registers the
 * lead as the current call target so the `C` shortcut and the palette "Call lead…"
 * command dial the lead in view. A DNC lead cannot be dialed from here (the pill
 * already flags it, and the engine would hard-block anyway).
 */
export function LeadCallLauncher({ lead }: { lead: Lead }): JSX.Element {
  const { startCall, setFocusTarget, isBusy } = useCall();

  // Register the in-view lead as the call target (palette + `C`), clear on leave.
  useEffect(() => {
    setFocusTarget({ leadId: lead.id, leadName: lead.name });
    return () => setFocusTarget(null);
  }, [lead.id, lead.name, setFocusTarget]);

  const dial = (): void => {
    void startCall({ leadId: lead.id, leadName: lead.name }, { via: 'dial', origin: 'pointer' });
  };

  const keyDefs: KeyBindingDef[] = [
    {
      id: 'calling:call-lead',
      combo: 'c',
      scope: 'route',
      label: `Call ${lead.name}`,
      group: 'Lead',
      when: () => !lead.dnc,
      handler: () => {
        if (!lead.dnc) dial();
      },
    },
  ];
  useKeyBindings(keyDefs);

  return (
    <Button
      size="sm"
      onClick={dial}
      disabled={lead.dnc || isBusy}
      title={
        lead.dnc
          ? 'Do not contact'
          : isBusy
            ? 'A call is already in progress'
            : 'Call primary phone (C)'
      }
      aria-keyshortcuts="C"
    >
      <PhoneIcon size={14} /> Call
    </Button>
  );
}
