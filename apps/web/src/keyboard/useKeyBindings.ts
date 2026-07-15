import { useEffect, useRef } from 'react';
import { useKeyboard } from './KeyboardProvider.tsx';
import type { KeyBindingDef, RegistrationInput } from './types.ts';

/**
 * Signature of a binding's *dispatch/display* metadata — everything except the
 * handler and `when` closures. Registration is keyed on this, so re-rendering
 * with fresh inline handlers does NOT churn the registry, yet dispatch always
 * calls the latest handler (read live through a ref).
 */
function metaSignature(def: KeyBindingDef): string {
  return [
    def.id,
    def.combo,
    def.scope,
    def.label,
    def.group ?? '',
    def.allowInInput === true ? 1 : 0,
    def.preventDefault === false ? 0 : 1,
    def.hidden === true ? 1 : 0,
    def.when ? 1 : 0,
  ].join('|');
}

/**
 * Declaratively register keyboard bindings for the lifetime of a component.
 *
 * Handlers and `when` guards are always invoked in their latest form (so they
 * can freely close over current props/state), while the underlying registry
 * subscription is stable unless a binding's visible metadata changes.
 */
export function useKeyBindings(defs: readonly KeyBindingDef[]): void {
  const { register } = useKeyboard();
  const defsRef = useRef(defs);
  defsRef.current = defs;

  const signature = defs.map(metaSignature).join(';;');

  useEffect(() => {
    const snapshot = defsRef.current;
    const unregisters = snapshot.map((def) => {
      const input: RegistrationInput = {
        id: def.id,
        combo: def.combo,
        scope: def.scope,
        label: def.label,
        ...(def.group !== undefined ? { group: def.group } : {}),
        allowInInput: def.allowInInput === true,
        preventDefault: def.preventDefault !== false,
        hidden: def.hidden === true,
        when: () => {
          const current = defsRef.current.find((d) => d.id === def.id);
          return current?.when ? current.when() : true;
        },
        handler: (event) => {
          const current = defsRef.current.find((d) => d.id === def.id);
          current?.handler(event);
        },
      };
      return register(input);
    });
    return () => {
      for (const unregister of unregisters) unregister();
    };
    // signature captures every field that affects registration; handlers stay live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, signature]);
}
