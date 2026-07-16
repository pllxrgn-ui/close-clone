import { useEffect, useState } from 'react';
import type { FormEvent, JSX, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState, Input, Skeleton } from '../../../../ui/index.ts';
import { ApiError } from '../../../../api/index.ts';
import { useToast } from '../../../../feedback/ToastProvider.tsx';
import { getOrgSettings, updateDailySendCap } from '../../api.ts';
import { ORG_SETTINGS_QUERY_KEY } from '../../queryKeys.ts';
import { LockIcon } from '../../icons.tsx';

/*
 * Compliance — org rails rendered as the audit story. Recording is OFF and cannot
 * be toggled here (legal sign-off only, I-REC); unsubscribe + quiet hours are
 * always-on rails; only the daily send cap is editable (the write pattern). Every
 * row carries its audit rationale in mono. Switches are display-only visuals — the
 * live state is announced in text, so the toggle glyph is decorative.
 */

interface RailRowProps {
  label: string;
  on: boolean;
  rationale: string;
  children?: ReactNode;
}

function RailRow({ label, on, rationale, children }: RailRowProps): JSX.Element {
  return (
    <div className="admin-rail-row">
      <div className="admin-rail-row__main">
        <LockIcon size={14} className="admin-rail-row__lock" title="Managed by an admin" />
        <span className="admin-rail-row__label">{label}</span>
        {children ?? (
          <span className="admin-rail-row__state">
            <span className="admin-rail-row__value">{on ? 'On' : 'Off'}</span>
            <span className="admin-switch" data-on={on ? '' : undefined} aria-hidden="true" />
          </span>
        )}
      </div>
      <p className="admin-rail-row__why admin-mono">{rationale}</p>
    </div>
  );
}

export function ComplianceSection(): JSX.Element {
  const settingsQuery = useQuery({
    queryKey: ORG_SETTINGS_QUERY_KEY,
    queryFn: () => getOrgSettings(),
  });
  const settings = settingsQuery.data;

  return (
    <section className="admin-section" aria-labelledby="admin-comp-title">
      <header className="admin-section__head">
        <h1 id="admin-comp-title" className="admin-section__title">
          Compliance
        </h1>
        <p className="admin-section__desc">
          Org-wide rails enforced by the engine on every send and dial — the app cannot bypass them.
        </p>
      </header>

      {settingsQuery.isLoading ? (
        <div className="admin-stack" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={56} />
          ))}
        </div>
      ) : settingsQuery.isError || !settings ? (
        <EmptyState
          title="Couldn’t load compliance settings"
          description={
            settingsQuery.error instanceof ApiError ? settingsQuery.error.message : 'Try again.'
          }
          actions={<Button onClick={() => void settingsQuery.refetch()}>Retry</Button>}
        />
      ) : (
        <div className="admin-rails">
          <RailRow
            label="Call recording"
            on={settings.recordingEnabled}
            rationale={`requires legal sign-off · recordingEnabledBy: ${settings.recordingEnabledBy ?? 'none'} · signoff: ${settings.recordingLegalSignoffRef ?? 'none'} · I-REC`}
          />
          <RailRow
            label="Honor unsubscribe"
            on
            rationale="always on · every sequence email carries List-Unsubscribe (mailto + one-click) · I-SEND-5"
          />
          <RailRow
            label="Quiet hours (SMS)"
            on
            rationale={`no outbound SMS outside ${quietHoursLabel(settings.quietHours)} · I-QUIET`}
          >
            <span className="admin-rail-row__state">
              <span className="admin-rail-row__value admin-mono">
                {quietHoursLabel(settings.quietHours)}
              </span>
            </span>
          </RailRow>
          <DailyCapRow value={settings.dailySendCap} />
        </div>
      )}
    </section>
  );
}

function quietHoursLabel(quietHours: Record<string, unknown> | null): string {
  const start = typeof quietHours?.start === 'string' ? quietHours.start : '08:00';
  const end = typeof quietHours?.end === 'string' ? quietHours.end : '21:00';
  return `${start}–${end} recipient-local`;
}

function DailyCapRow({ value }: { value: number }): JSX.Element {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const mutation = useMutation({
    mutationFn: (cap: number) => updateDailySendCap(cap),
    onSuccess: (updated) => {
      void queryClient.setQueryData(ORG_SETTINGS_QUERY_KEY, updated);
      toast(`Daily send cap set to ${updated.dailySendCap.toLocaleString('en-US')}`);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not update the cap.'),
  });

  const parsed = Number.parseInt(draft, 10);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100_000;
  const dirty = String(value) !== draft.trim();

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) {
      setError('Enter a whole number between 1 and 100000.');
      return;
    }
    mutation.mutate(parsed);
  };

  return (
    <div className="admin-rail-row">
      <form className="admin-rail-row__main" onSubmit={onSubmit}>
        <LockIcon size={14} className="admin-rail-row__lock" title="Editable by an admin" />
        <span className="admin-rail-row__label">
          <label htmlFor="admin-daily-cap">Daily send cap</label>
        </span>
        <span className="admin-rail-row__edit">
          <Input
            id="admin-daily-cap"
            type="number"
            min={1}
            max={100000}
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            invalid={!valid}
            className="admin-cap-input admin-mono"
            aria-describedby="admin-cap-why"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!dirty || !valid}
            loading={mutation.isPending}
          >
            Save
          </Button>
        </span>
      </form>
      <p id="admin-cap-why" className="admin-rail-row__why admin-mono">
        per-mailbox outbound cap · counter increments inside the send transaction · I-SEND-4
        {error ? ` · ${error}` : ''}
      </p>
    </div>
  );
}
