import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, ReactNode } from 'react';
import { eventToCombo, isSequence, isTypingTarget, sequencePrefix } from './combo.ts';
import { SCOPE_RANK } from './types.ts';
import type { KeyboardContextValue, RegisteredBinding, RegistrationInput } from './types.ts';

const KeyboardContext = createContext<KeyboardContextValue | null>(null);

/** How long the first key of a sequence (e.g. `g`) stays armed. */
export const SEQUENCE_TIMEOUT_MS = 900;

interface KeyboardProviderProps {
  children: ReactNode;
  /** Warn on duplicate combo+scope registrations. Defaults to non-production. */
  detectConflicts?: boolean;
}

/**
 * Owns the single global keydown listener and the binding registry.
 *
 * Dispatch order for a keydown:
 *   1. If a sequence prefix is armed and still fresh, try to complete it.
 *   2. Otherwise, if the combo is itself a sequence prefix, arm it.
 *   3. Otherwise resolve the combo against registered bindings, honoring the
 *      input guard (typing → only `allowInInput` bindings), `when` guards, and
 *      scope precedence (list > route > global; later registration wins ties).
 *
 * The listener is attached in the bubble phase so component-level handlers
 * (modal focus traps) can `stopPropagation()` to intercept first.
 */
export function KeyboardProvider({
  children,
  detectConflicts = !import.meta.env.PROD,
}: KeyboardProviderProps): JSX.Element {
  // The map is the dispatch source of truth (always current, no re-subscribe).
  const registryRef = useRef<Map<string, RegisteredBinding>>(new Map());
  const orderRef = useRef(0);
  const pendingRef = useRef<{ prefix: string; at: number } | null>(null);
  // A reactive snapshot for consumers that must render bindings (the cheat sheet).
  const [bindings, setBindings] = useState<readonly RegisteredBinding[]>([]);

  const publish = useCallback(() => {
    setBindings([...registryRef.current.values()]);
  }, []);

  const register = useCallback(
    (input: RegistrationInput): (() => void) => {
      if (detectConflicts) {
        for (const existing of registryRef.current.values()) {
          if (existing.combo === input.combo && existing.scope === input.scope) {
            // eslint-disable-next-line no-console
            console.warn(
              `[keyboard] conflict: "${input.combo}" is bound twice in scope "${input.scope}" ` +
                `(ids: ${existing.id}, ${input.id})`,
            );
          }
        }
      }
      const order = (orderRef.current += 1);
      registryRef.current.set(input.id, { ...input, order });
      publish();
      return () => {
        registryRef.current.delete(input.id);
        pendingRef.current = null;
        publish();
      };
    },
    [detectConflicts, publish],
  );

  useEffect(() => {
    function resolve(combo: string, typing: boolean): RegisteredBinding | null {
      let best: RegisteredBinding | null = null;
      for (const binding of registryRef.current.values()) {
        if (binding.combo !== combo) continue;
        if (typing && !binding.allowInInput) continue;
        if (!binding.when()) continue;
        if (
          best === null ||
          SCOPE_RANK[binding.scope] > SCOPE_RANK[best.scope] ||
          (SCOPE_RANK[binding.scope] === SCOPE_RANK[best.scope] && binding.order > best.order)
        ) {
          best = binding;
        }
      }
      return best;
    }

    function isArmablePrefix(combo: string): boolean {
      for (const binding of registryRef.current.values()) {
        if (!isSequence(binding.combo)) continue;
        if (sequencePrefix(binding.combo) !== combo) continue;
        if (!binding.when()) continue;
        return true;
      }
      return false;
    }

    function fire(binding: RegisteredBinding, event: KeyboardEvent): void {
      if (binding.preventDefault) event.preventDefault();
      binding.handler(event);
    }

    function onKeyDown(event: KeyboardEvent): void {
      // Ignore standalone modifier presses (they only ever combine).
      if (
        event.key === 'Control' ||
        event.key === 'Meta' ||
        event.key === 'Alt' ||
        event.key === 'Shift'
      ) {
        return;
      }

      const combo = eventToCombo(event);
      const typing = isTypingTarget(event.target);
      const now = performance.now();

      const pending = pendingRef.current;
      if (pending && now - pending.at <= SEQUENCE_TIMEOUT_MS) {
        pendingRef.current = null;
        const seqMatch = resolve(`${pending.prefix} ${combo}`, typing);
        if (seqMatch) fire(seqMatch, event);
        // The second key is consumed by the sequence attempt either way.
        return;
      }
      pendingRef.current = null;

      // Arm a sequence prefix (never while typing in a field).
      if (!typing && isArmablePrefix(combo)) {
        pendingRef.current = { prefix: combo, at: now };
        return;
      }

      const match = resolve(combo, typing);
      if (match) fire(match, event);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo<KeyboardContextValue>(() => ({ register, bindings }), [register, bindings]);

  return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
}

export function useKeyboard(): KeyboardContextValue {
  const ctx = useContext(KeyboardContext);
  if (!ctx) {
    throw new Error('useKeyboard must be used within a KeyboardProvider');
  }
  return ctx;
}
