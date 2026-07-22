import { StrictMode, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Combobox, Field, IconButton, type ComboboxOption } from '../ui/index.ts';
import { CloseIcon, MoonIcon, SunIcon } from '../ui/icons.tsx';
import '../styles/tokens.css';
import '../styles/base.css';
import '../ui/primitives.css';
import '../styles/overlays.css';
import '../features/leads/leads.css';
import './playground.css';

/*
 * Throwaway interactive playground for the new Combobox (primitive states +
 * the bulk-bar reveal-in-place migration). Not part of the app build. Real
 * components — click, type, arrow-key, Esc; toggle the theme top-right.
 */

const REPS: ComboboxOption[] = [
  {
    value: 'ada',
    label: 'Ada Lovelace',
    sublabel: 'ada@switchboard.io',
    accent: 'var(--state-live)',
  },
  { value: 'bo', label: 'Bo Diaz', sublabel: 'bo@switchboard.io', accent: 'var(--state-reply)' },
  { value: 'cy', label: 'Cyrus Vandenberg-Montgomery', sublabel: 'cy@switchboard.io' },
  { value: 'di', label: 'Di Okafor', sublabel: 'di@switchboard.io — on leave', disabled: true },
  { value: 'em', label: 'Emil Rossi', sublabel: 'em@switchboard.io', accent: 'var(--state-seq)' },
  { value: 'fa', label: 'Farah Nazari', sublabel: 'fa@switchboard.io' },
  { value: 'gu', label: 'Gustavo Park', sublabel: 'gu@switchboard.io' },
];

const STATUSES: ComboboxOption[] = [
  { value: 'new', label: 'New', accent: 'var(--state-reply)' },
  { value: 'working', label: 'Working', accent: 'var(--state-live)' },
  { value: 'won', label: 'Won', accent: 'var(--state-reply)' },
  { value: 'lost', label: 'Lost', accent: 'var(--state-idle)' },
];

function Cell({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="pg-cell">
      <span className="pg-cell__title">{title}</span>
      {children}
    </div>
  );
}

function BulkBar(): JSX.Element {
  const [dialog, setDialog] = useState<null | 'owner' | 'status' | 'sequence'>(null);
  const [last, setLast] = useState<string>('—');
  const close = (): void => setDialog(null);
  const pick = (kind: string, opts: ComboboxOption[]) => (id: string | null) => {
    setLast(`${kind}: ${opts.find((o) => o.value === id)?.label ?? id}`);
    close();
  };

  return (
    <div className="pg-bulkwrap">
      <div className="bulk-bar" role="region" aria-label="12 leads selected">
        <span className="bulk-bar__count">
          <strong>12</strong> selected
        </span>
        <div className="bulk-bar__actions">
          {dialog === 'owner' ? (
            <Combobox
              label="Assign owner"
              className="bulk-bar__picker"
              placeholder="Search reps…"
              defaultOpen
              clearable={false}
              value={null}
              options={REPS}
              onChange={pick('Owner', REPS)}
              onClose={close}
            />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setDialog('owner')}>
              Assign owner
            </Button>
          )}
          {dialog === 'status' ? (
            <Combobox
              label="Set status"
              className="bulk-bar__picker"
              placeholder="Set status…"
              defaultOpen
              clearable={false}
              value={null}
              options={STATUSES}
              onChange={pick('Status', STATUSES)}
              onClose={close}
            />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setDialog('status')}>
              Edit status
            </Button>
          )}
          {dialog === 'sequence' ? (
            <Combobox
              label="Enroll in sequence"
              className="bulk-bar__picker"
              placeholder="Search sequences…"
              defaultOpen
              clearable={false}
              value={null}
              options={[
                { value: 'ob', label: 'Onboarding', sublabel: '128 active' },
                { value: 'nu', label: 'Nurture', sublabel: '412 active' },
                { value: 'rb', label: 'Win-back', sublabel: '37 active' },
              ]}
              onChange={pick('Sequence', [
                { value: 'ob', label: 'Onboarding' },
                { value: 'nu', label: 'Nurture' },
                { value: 'rb', label: 'Win-back' },
              ])}
              onClose={close}
            />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setDialog('sequence')}>
              Enroll in sequence
            </Button>
          )}
          <Button size="sm" variant="ghost">
            Export CSV
          </Button>
          <Button size="sm" variant="ghost">
            Set DNC
          </Button>
        </div>
        <IconButton label="Clear selection" className="bulk-bar__clear">
          <CloseIcon size={16} />
        </IconButton>
      </div>
      <p className="pg-lastpick">
        Last action fired → <strong>{last}</strong>
      </p>
    </div>
  );
}

function Playground(): JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [owner, setOwner] = useState<string | null>('bo');
  const [seq, setSeq] = useState<string | null>('em');
  const [invalidOwner, setInvalidOwner] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const toggle = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
  };

  return (
    <div className="pg">
      <header className="pg-head">
        <div>
          <h1 className="pg-h1">Combobox</h1>
          <p className="pg-sub">
            Searchable single-select · type to filter · ↑↓ Enter · Esc · click-outside
          </p>
        </div>
        <IconButton label="Toggle theme" onClick={toggle}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </IconButton>
      </header>

      <section className="pg-grid">
        <Cell title="Default (assign owner)">
          <Combobox
            label="Assign owner"
            options={REPS}
            value={owner}
            onChange={setOwner}
            placeholder="Search reps…"
          />
        </Cell>
        <Cell title="Inside a Field (+ hint)">
          <Field label="Sequence" hint="Enrolling pauses on reply">
            <Combobox label="Sequence" options={REPS} value={seq} onChange={setSeq} />
          </Field>
        </Cell>
        <Cell title="Error state (via Field)">
          <Field label="Owner" error="Pick an owner to continue">
            <Combobox
              label="Owner"
              options={REPS}
              value={invalidOwner}
              onChange={setInvalidOwner}
            />
          </Field>
        </Cell>
        <Cell title="Loading (async)">
          <Combobox
            label="Search accounts"
            options={[]}
            value={null}
            onChange={() => {}}
            loading
            onInputChange={() => {}}
            placeholder="Searching…"
          />
        </Cell>
        <Cell title="Disabled">
          <Combobox label="Territory" options={REPS} value="ada" onChange={() => {}} disabled />
        </Cell>
        <Cell title="Status (short list)">
          <Combobox
            label="Status"
            options={STATUSES}
            value={status}
            onChange={setStatus}
            placeholder="Set status…"
          />
        </Cell>
      </section>

      <h2 className="pg-h2">Bulk bar — reveal-in-place migration</h2>
      <p className="pg-sub">
        Click a picker button; it swaps for an open, focused Combobox in place. Pick fires the
        action; Esc / clicking away reverts to the button.
      </p>
      <BulkBar />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
