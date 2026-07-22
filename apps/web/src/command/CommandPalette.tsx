import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { Modal } from '../ui/Modal.tsx';
import { CornerDownLeftIcon, SearchIcon } from '../ui/icons.tsx';
import { KbdCombo } from '../keyboard/index.ts';
import { fuzzyMatch, scoreEntry } from './fuzzy.ts';
import { useDebouncedValue } from './useDebouncedValue.ts';
import { COMMAND_GROUPS, useLeadCommands, useStaticCommands } from './commands.ts';
import type { Command, CommandGroupName } from './commands.ts';
import { useCommsCommands } from '../features/comms/commands.ts';
import { useAdminCommands } from '../features/admin/commands.ts';
import { usePipelineCommands } from '../features/pipeline/commands/commands.ts';
import { useInboxCommands } from '../features/inbox/commands.ts';
import { useCallingCommands } from '../features/calling/commands.ts';
import { useSmsCommands } from '../features/sms/commands.ts';
import { useAiCommands } from '../features/ai/commands.ts';
import { useImportCommands } from '../features/import/commands.ts';

interface OptionVM {
  command: Command;
  ranges: Array<[number, number]>;
}

interface SectionVM {
  name: CommandGroupName;
  options: OptionVM[];
}

type Row = { kind: 'title'; name: string } | { kind: 'option'; option: OptionVM; index: number };

/** Filter + rank one group's commands against the query (empty query = all). */
function filterGroup(query: string, commands: Command[]): OptionVM[] {
  if (query.trim() === '') return commands.map((command) => ({ command, ranges: [] }));
  const scored: Array<{ vm: OptionVM; score: number }> = [];
  for (const command of commands) {
    const match = scoreEntry(query, command.title, command.keywords);
    if (match) scored.push({ vm: { command, ranges: match.ranges }, score: match.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.vm);
}

function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: Array<[number, number]>;
}): ReactNode {
  if (ranges.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) nodes.push(<span key={`t${index}`}>{text.slice(cursor, start)}</span>);
    nodes.push(
      <mark key={`m${index}`} className="sb-palette__match">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  return nodes;
}

/**
 * The Cmd/Ctrl+K command palette: fuzzy search over navigation, live lead
 * search, action placeholders, and the theme toggle. Fully keyboard-driven
 * (arrows/enter/escape) with the aria-combobox pattern; focus is trapped in the
 * input and restored to the opener on close (via Modal).
 */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Map<number, HTMLElement>>(new Map());
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-opt-${index}`;

  const debouncedQuery = useDebouncedValue(query, 120);
  const commsCommands = useCommsCommands(onClose);
  const adminCommands = useAdminCommands(onClose);
  const pipelineCommands = usePipelineCommands(onClose);
  const inboxCommands = useInboxCommands(onClose);
  const callingCommands = useCallingCommands(onClose);
  const smsCommands = useSmsCommands(onClose);
  const aiCommands = useAiCommands(onClose);
  const importCommands = useImportCommands(onClose);
  const staticCommands = [
    ...useStaticCommands(onClose),
    ...commsCommands,
    ...adminCommands,
    ...pipelineCommands,
    ...inboxCommands,
    ...callingCommands,
    ...smsCommands,
    ...aiCommands,
    ...importCommands,
  ];
  const leadCommands = useLeadCommands(debouncedQuery, onClose);

  const sections = useMemo<SectionVM[]>(() => {
    const byGroup = (name: CommandGroupName): Command[] =>
      staticCommands.filter((command) => command.group === name);
    const leadOptions: OptionVM[] = leadCommands.map((command) => ({
      command,
      ranges: fuzzyMatch(debouncedQuery, command.title)?.ranges ?? [],
    }));
    const built: Record<CommandGroupName, OptionVM[]> = {
      Navigate: filterGroup(query, byGroup('Navigate')),
      Leads: leadOptions,
      Actions: filterGroup(query, byGroup('Actions')),
      Theme: filterGroup(query, byGroup('Theme')),
    };
    return COMMAND_GROUPS.map((name) => ({ name, options: built[name] })).filter(
      (section) => section.options.length > 0,
    );
  }, [query, debouncedQuery, staticCommands, leadCommands]);

  const { rows, count } = useMemo(() => {
    const out: Row[] = [];
    let index = -1;
    for (const section of sections) {
      out.push({ kind: 'title', name: section.name });
      for (const option of section.options) {
        index += 1;
        out.push({ kind: 'option', option, index });
      }
    }
    return { rows: out, count: index + 1 };
  }, [sections]);

  const activeIndex = count === 0 ? -1 : Math.min(active, count - 1);

  // Reset query/selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // Reset the highlight to the top whenever the typed query changes.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the active option scrolled into view (no-op in jsdom).
  useEffect(() => {
    if (activeIndex < 0) return;
    optionRefs.current.get(activeIndex)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  function onInputKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        setActive((index) => Math.min(index + 1, count - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        setActive((index) => Math.max(index - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        setActive(count - 1);
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        if (activeIndex >= 0) findOption(rows, activeIndex)?.command.run();
        break;
      // Escape + Tab bubble to Modal (close / focus-trap).
      default:
        break;
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Command palette"
      initialFocusRef={inputRef}
      className="sb-palette"
      backdropClassName="sb-overlay--top"
    >
      <div className="sb-palette__search">
        <SearchIcon size={16} className="sb-palette__search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="sb-palette__input"
          role="combobox"
          aria-label="Command palette"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          {...(activeIndex >= 0 ? { 'aria-activedescendant': optionId(activeIndex) } : {})}
          placeholder="Type a command or search leads…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
      </div>

      <ul className="sb-palette__list" id={listboxId} role="listbox" aria-label="Commands">
        {count === 0 ? (
          <li className="sb-palette__empty" role="presentation">
            No matches for “{query.trim()}”.
          </li>
        ) : (
          rows.map((row) =>
            row.kind === 'title' ? (
              <li
                key={`title:${row.name}`}
                role="presentation"
                className="sb-palette__section-title"
              >
                {row.name}
              </li>
            ) : (
              <li
                key={row.option.command.id}
                id={optionId(row.index)}
                role="option"
                aria-selected={row.index === activeIndex}
                aria-label={row.option.command.title}
                className={
                  row.index === activeIndex ? 'sb-palette__opt is-active' : 'sb-palette__opt'
                }
                ref={(el) => {
                  if (el) optionRefs.current.set(row.index, el);
                  else optionRefs.current.delete(row.index);
                }}
                onMouseMove={() => setActive(row.index)}
                onClick={() => row.option.command.run()}
              >
                <span className="sb-palette__opt-main">
                  <span className="sb-palette__opt-title">
                    <Highlighted text={row.option.command.title} ranges={row.option.ranges} />
                  </span>
                  {row.option.command.subtitle ? (
                    <span className="sb-palette__opt-sub">{row.option.command.subtitle}</span>
                  ) : null}
                </span>
                {row.option.command.shortcut ? (
                  <KbdCombo combo={row.option.command.shortcut} className="sb-palette__opt-kbd" />
                ) : null}
              </li>
            ),
          )
        )}
      </ul>

      <div className="sb-palette__footer" aria-hidden="true">
        <span className="sb-palette__hint">
          <KbdCombo combo="arrowdown" />
          <KbdCombo combo="arrowup" />
          navigate
        </span>
        <span className="sb-palette__hint">
          <CornerDownLeftIcon size={13} /> run
        </span>
        <span className="sb-palette__hint">
          <KbdCombo combo="escape" /> close
        </span>
      </div>
    </Modal>
  );
}

function findOption(rows: Row[], index: number): OptionVM | undefined {
  for (const row of rows) {
    if (row.kind === 'option' && row.index === index) return row.option;
  }
  return undefined;
}
