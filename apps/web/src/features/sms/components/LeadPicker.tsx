import { useState } from 'react';
import type { JSX, RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '../../../ui/index.ts';
import { search } from '../../../api/search.ts';
import { useDebouncedValue } from '../../../command/index.ts';
import { SearchIcon } from '../icons.tsx';

/*
 * Palette-entry step: when the composer is summoned without a lead ("Text lead…"),
 * pick who to text. Reuses the global search endpoint (same source as the command
 * palette + comms composer). Selecting a lead hands its id up to the drawer, which
 * swaps to the conversation.
 */

interface LeadPickerProps {
  onPick: (leadId: string) => void;
  onClose: () => void;
  searchRef: RefObject<HTMLElement | null>;
}

export function LeadPicker({ onPick, searchRef }: LeadPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 150);
  const trimmed = debounced.trim();
  const { data, isFetching } = useQuery({
    queryKey: ['sms-lead-search', trimmed],
    queryFn: ({ signal }) => search(trimmed, signal),
    enabled: trimmed.length > 0,
    staleTime: 15_000,
  });
  const leads = (data?.items ?? []).filter((hit) => hit.type === 'lead').slice(0, 8);

  return (
    <div className="sms-drawer__scroll">
      <label className="sms-field">
        <span className="sms-field__label">Lead</span>
        <span className="sms-search">
          <SearchIcon size={14} className="sms-search__icon" />
          <Input
            ref={searchRef as RefObject<HTMLInputElement>}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search leads to text…"
            aria-label="Search leads"
            autoComplete="off"
            spellCheck={false}
          />
        </span>
      </label>
      {trimmed.length === 0 ? (
        <p className="sms-hint">Search for the lead you want to text.</p>
      ) : leads.length === 0 && !isFetching ? (
        <p className="sms-hint">No leads match “{trimmed}”.</p>
      ) : (
        <ul className="sms-picklist" aria-label="Lead results">
          {leads.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="sb-row sms-picklist__row"
                onClick={() => onPick(hit.leadId)}
              >
                <span className="sms-picklist__name">{hit.title}</span>
                {hit.subtitle ? <span className="sms-picklist__sub">{hit.subtitle}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
