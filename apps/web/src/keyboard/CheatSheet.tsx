import { useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { Modal } from '../ui/Modal.tsx';
import { VisuallyHidden } from '../ui/VisuallyHidden.tsx';
import { StateLegend } from '../ui/StateLegend.tsx';
import { CloseIcon } from '../ui/icons.tsx';
import { readableCombo } from './combo.ts';
import { KbdCombo } from './KbdCombo.tsx';
import { useKeyboard } from './KeyboardProvider.tsx';
import { SCOPE_RANK } from './types.ts';
import type { RegisteredBinding, Scope } from './types.ts';

const SCOPE_LABEL: Record<Scope, string> = {
  global: 'Global',
  route: 'This page',
  list: 'List',
};

interface CheatGroup {
  name: string;
  rank: number;
  items: RegisteredBinding[];
}

/** Group the active, visible bindings by their display group for the sheet. */
function groupBindings(bindings: readonly RegisteredBinding[]): CheatGroup[] {
  const groups = new Map<string, CheatGroup>();
  for (const binding of bindings) {
    if (binding.hidden) continue;
    if (!binding.when()) continue;
    const name = binding.group ?? SCOPE_LABEL[binding.scope];
    const existing = groups.get(name);
    if (existing) {
      existing.rank = Math.min(existing.rank, SCOPE_RANK[binding.scope]);
      existing.items.push(binding);
    } else {
      groups.set(name, { name, rank: SCOPE_RANK[binding.scope], items: [binding] });
    }
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.items.sort((a, b) => a.label.localeCompare(b.label));
  }
  result.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return result;
}

/**
 * The `?` cheat-sheet overlay. Lists every currently-active binding grouped by
 * scope/group, straight from the live registry — so it always reflects exactly
 * what is bound in the current context (route + focused list included).
 */
export function CheatSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const { bindings } = useKeyboard();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const groups = useMemo(() => groupBindings(bindings), [bindings]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Keyboard shortcuts"
      initialFocusRef={closeRef}
      className="sb-cheatsheet"
      backdropClassName="sb-overlay--center"
    >
      <header className="sb-cheatsheet__head">
        <h2 className="sb-cheatsheet__title">Keyboard shortcuts</h2>
        <button
          ref={closeRef}
          type="button"
          className="sb-iconbtn"
          aria-label="Close shortcuts"
          onClick={onClose}
        >
          <CloseIcon size={16} />
        </button>
      </header>

      {groups.length === 0 ? (
        <p className="sb-cheatsheet__empty">No shortcuts are active here.</p>
      ) : (
        <div className="sb-cheatsheet__grid">
          {groups.map((group) => (
            <section key={group.name} className="sb-cheatsheet__group">
              <h3 className="sb-cheatsheet__group-title">{group.name}</h3>
              <ul className="sb-cheatsheet__list">
                {group.items.map((binding) => (
                  <li key={binding.id} className="sb-cheatsheet__row">
                    <span className="sb-cheatsheet__label">{binding.label}</span>
                    <span className="sb-cheatsheet__keys">
                      <VisuallyHidden>{readableCombo(binding.combo)}</VisuallyHidden>
                      <KbdCombo combo={binding.combo} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <hr className="sb-cheatsheet__divider" />
      <StateLegend />
    </Modal>
  );
}
