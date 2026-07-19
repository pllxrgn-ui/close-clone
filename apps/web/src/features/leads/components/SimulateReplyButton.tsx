import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Activity, Lead } from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';
import { ApiError } from '../../../api/index.ts';
import { useToast } from '../../../feedback/index.ts';
import { Button } from '../../../ui/index.ts';
import { MessageIcon } from '../icons.tsx';

/*
 * DEMO control: the static demo has no Gmail/Twilio, so nothing inbound can
 * arrive on its own — this button stands in for the sync engine and lands a
 * real email_received from this lead's contact (timeline + NEW-REPLY signal +
 * reply-pause on any live enrollment, the §4.3 story). Renders only in mock
 * mode; in real mode actual inbound flows through the same activity pipeline.
 */

interface SimulateReplyResult {
  activity: Activity;
  contactName: string;
  subject: string;
  paused: number;
}

export function SimulateReplyButton({ lead }: { lead: Lead }): JSX.Element | null {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<SimulateReplyResult>('/demo/inbound-reply', {
        method: 'POST',
        body: { leadId: lead.id },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['lead-timeline', lead.id] });
      void queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
      toast(
        result.paused > 0
          ? `Reply arrived — "${result.subject}" · sequence paused (reply)`
          : `Reply arrived — "${result.subject}"`,
      );
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Could not simulate a reply');
    },
  });

  if (import.meta.env.VITE_API_MODE === 'real') return null;

  return (
    <Button
      size="sm"
      variant="ghost"
      className="lead-demo-reply"
      onClick={() => mutation.mutate()}
      loading={mutation.isPending}
      title="Demo only — generates an inbound email from this lead's contact. In real mode, actual replies arrive via the connected Gmail/Twilio accounts."
    >
      <MessageIcon size={13} /> Demo · Simulate a reply
    </Button>
  );
}
