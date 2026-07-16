import type { JSX } from 'react';
import type { Snippet } from '@switchboard/shared';
import { SlashIcon } from '../icons.tsx';

/*
 * The `/shortcut` autocomplete popover for the composer body. Presentational:
 * the composer owns the active index + keyboard handling (Arrow/Enter/Tab/Esc)
 * and passes the filtered snippet list here. Rendered as an aria listbox so the
 * textarea can point aria-activedescendant at the active option.
 */
export function SnippetMenu({
  snippets,
  activeIndex,
  listboxId,
  optionId,
  onPick,
  onHover,
}: {
  snippets: Snippet[];
  activeIndex: number;
  listboxId: string;
  optionId: (index: number) => string;
  onPick: (snippet: Snippet) => void;
  onHover: (index: number) => void;
}): JSX.Element {
  return (
    <ul className="comms-snip" id={listboxId} role="listbox" aria-label="Snippets">
      {snippets.map((snippet, i) => (
        <li
          key={snippet.id}
          id={optionId(i)}
          role="option"
          aria-selected={i === activeIndex}
          className={i === activeIndex ? 'comms-snip__opt is-active' : 'comms-snip__opt'}
          onMouseMove={() => onHover(i)}
          // Use mousedown so the textarea doesn't blur before the insert runs.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(snippet);
          }}
        >
          <span className="comms-snip__shortcut">
            <SlashIcon size={12} />
            {snippet.shortcut}
          </span>
          <span className="comms-snip__body">{snippet.body.replace(/\s+/g, ' ').trim()}</span>
        </li>
      ))}
    </ul>
  );
}
