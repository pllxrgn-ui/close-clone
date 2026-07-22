import { StrictMode, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { IconButton, Kbd } from '../ui/index.ts';
import { CheckIcon, ChevronDownIcon, MoonIcon, SunIcon } from '../ui/icons.tsx';
import '../styles/tokens.css';
import '../styles/base.css';
import '../ui/primitives.css';
import './rich-proposal.css';

/*
 * PROPOSAL mockup for a richer Combobox — the "channel strip" treatment.
 * Static, throwaway, not wired to the real component. For sign-off only.
 */

type State = 'live' | 'reply' | 'seq' | 'overdue' | 'idle';

function Lamp({ state }: { state: State }): JSX.Element {
  return <span className="rp-lamp" data-state={state} aria-hidden="true" />;
}

interface Row {
  tag: string;
  name: string;
  meta: string;
  state: State;
  selected?: boolean;
  active?: boolean;
  disabled?: boolean;
}

const REPS: Row[] = [
  { tag: 'AL', name: 'Ada Lovelace', meta: 'AE', state: 'live', selected: true },
  { tag: 'BD', name: 'Bo Diaz', meta: 'SDR', state: 'reply', active: true },
  { tag: 'CV', name: 'Cyrus Vandenberg-Montgomery', meta: 'AE', state: 'idle' },
  { tag: 'DO', name: 'Di Okafor', meta: 'on leave', state: 'idle', disabled: true },
  { tag: 'ER', name: 'Emil Rossi', meta: 'SDR', state: 'seq' },
  { tag: 'FN', name: 'Farah Nazari', meta: 'AE', state: 'idle' },
];

const STATUSES: Row[] = [
  { tag: '01', name: 'New', meta: '340', state: 'reply' },
  { tag: '02', name: 'Working', meta: '128', state: 'live', active: true },
  { tag: '03', name: 'Qualified', meta: '86', state: 'seq' },
  { tag: '04', name: 'Won', meta: '52', state: 'reply', selected: true },
  { tag: '05', name: 'Lost', meta: '17', state: 'idle' },
];

function Panel({ cap, rows }: { cap: string; rows: Row[] }): JSX.Element {
  return (
    <div className="rp-panel">
      <div className="rp-panel__cap">
        <span>{cap}</span>
        <span>{rows.length}</span>
      </div>
      <div className="rp-list" role="listbox" aria-label={cap}>
        {rows.map((r) => (
          <div
            key={r.tag}
            className="rp-row"
            role="option"
            aria-selected={r.selected ?? false}
            data-active={r.active ? '' : undefined}
            data-disabled={r.disabled ? '' : undefined}
          >
            <Lamp state={r.state} />
            <span className="rp-tag">{r.tag}</span>
            <span className="rp-name">{r.name}</span>
            <span className="rp-meta">{r.meta}</span>
            {r.selected ? <CheckIcon className="rp-check" size={14} /> : null}
          </div>
        ))}
      </div>
      <div className="rp-foot">
        <span className="rp-foot__grp">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="rp-foot__grp">
          <Kbd>↵</Kbd> select
        </span>
        <span className="rp-foot__grp">
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </div>
  );
}

function ClosedControl({
  lamp,
  tag,
  name,
}: {
  lamp: State;
  tag: string;
  name: string;
}): JSX.Element {
  return (
    <div className="rp-control">
      <Lamp state={lamp} />
      <span className="rp-tag">{tag}</span>
      <span className="rp-control__name">{name}</span>
      <ChevronDownIcon className="rp-control__chev" size={14} />
    </div>
  );
}

function Proposal(): JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const toggle = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
  };
  return (
    <div className="rp">
      <div className="rp-head">
        <div>
          <h1 className="rp-h1">Combobox — richer “channel strip” proposal</h1>
          <p className="rp-sub">
            State lamp · mono channel tag · right-aligned data meta · keyboard strip footer. Color
            still = state only. Needs DESIGN.md sign-off.
          </p>
        </div>
        <IconButton label="Toggle theme" onClick={toggle}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </IconButton>
      </div>

      <div className="rp-cols">
        <div>
          <p className="rp-col__title">Assign owner — open</p>
          <ClosedControl lamp="live" tag="AL" name="Ada Lovelace" />
          <Panel cap="Reps" rows={REPS} />
        </div>
        <div>
          <p className="rp-col__title">Set status — open</p>
          <ClosedControl lamp="reply" tag="04" name="Won" />
          <Panel cap="Pipeline" rows={STATUSES} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Proposal />
  </StrictMode>,
);
