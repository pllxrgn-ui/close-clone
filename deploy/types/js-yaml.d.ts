/**
 * Minimal ambient declaration for `js-yaml`.
 *
 * The deploy kit installs `js-yaml` (offline-resolvable from the pnpm store) but
 * `@types/js-yaml` is intentionally NOT pulled in — the compose-invariants test
 * only needs `load`, and it treats the result as `unknown`, narrowing with the
 * local type guards in `compose-model.ts`. This keeps the kit dependency-light
 * and offline-installable. Swap this for `@types/js-yaml` if the kit ever grows
 * a wider surface.
 */
declare module 'js-yaml' {
  export function load(input: string): unknown;
}
