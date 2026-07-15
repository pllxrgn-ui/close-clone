/*
 * Keyboard layer — shared types.
 *
 * A binding is a declarative description of "when this key(combo) fires in this
 * scope, run this handler". Scopes form a precedence stack (list > route >
 * global): the most specific active scope shadows the others for the same combo.
 * See KeyboardProvider for the dispatch/resolution rules.
 */

/** Binding scopes, ordered here from least to most specific. */
export const SCOPES = ['global', 'route', 'list'] as const;
export type Scope = (typeof SCOPES)[number];

/** Higher rank = more specific = wins when two scopes claim the same combo. */
export const SCOPE_RANK: Record<Scope, number> = { global: 0, route: 1, list: 2 };

/**
 * A declarative binding as authored by a component via {@link useKeyBindings}.
 * `combo` is a canonical token (see combo.ts): a single chord like `mod+k`,
 * `?`, `escape`, `arrowdown`, `j`; or a two-step sequence like `g i`.
 */
export interface KeyBindingDef {
  /** Stable, unique id (used for dedupe, conflict messages, cheat-sheet keys). */
  id: string;
  /** Canonical combo or `first second` sequence. */
  combo: string;
  /** Which scope this binding lives in. */
  scope: Scope;
  /** Human description shown in the cheat sheet. */
  label: string;
  /** Cheat-sheet section this binding groups under (defaults to the scope). */
  group?: string;
  /** Fire even when focus is in a text field (Escape, Cmd/Ctrl+K). Default false. */
  allowInInput?: boolean;
  /** Call preventDefault when the binding fires. Default true. */
  preventDefault?: boolean;
  /** Hide from the cheat sheet (e.g. arrow-key aliases of j/k). Default false. */
  hidden?: boolean;
  /** Optional guard — the binding is inert (and invisible) when this returns false. */
  when?: () => boolean;
  handler: (event: KeyboardEvent) => void;
}

/** The normalized form the provider stores and dispatches against. */
export interface RegisteredBinding {
  id: string;
  combo: string;
  scope: Scope;
  label: string;
  group?: string;
  allowInInput: boolean;
  preventDefault: boolean;
  hidden: boolean;
  when: () => boolean;
  handler: (event: KeyboardEvent) => void;
  /** Monotonic registration order; later registrations win ties within a scope. */
  order: number;
}

/** What {@link useKeyBindings} hands the provider (order is assigned internally). */
export type RegistrationInput = Omit<RegisteredBinding, 'order'>;

export interface KeyboardContextValue {
  /** Register a binding; returns an unregister function. */
  register: (input: RegistrationInput) => () => void;
  /** Live snapshot of all registered bindings (drives the cheat sheet). */
  bindings: readonly RegisteredBinding[];
}
