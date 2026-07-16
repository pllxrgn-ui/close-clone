/**
 * Tiny hand-rolled argv parser for the `switchboard-admin` CLI (Task 5g). No
 * dependency (commander was the alternative — avoided to keep the dep list at
 * zero). Supports `command positionals... --flag value --flag=value --boolFlag`.
 *
 * Boolean flag names are declared up front so `--force` is never mistaken for
 * `--force <positional>`. Import-safe for direct `node` execution (no enums /
 * namespaces / parameter properties — the host type-stripping constraint).
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface ParseOptions {
  /** Flags that never consume a following value (e.g. `force`, `json`). */
  booleans?: readonly string[];
}

export function parseArgs(argv: readonly string[], opts: ParseOptions = {}): ParsedArgs {
  const booleans = new Set(opts.booleans ?? []);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eqAt = body.indexOf('=');
      if (eqAt >= 0) {
        flags[body.slice(0, eqAt)] = body.slice(eqAt + 1);
      } else if (booleans.has(body)) {
        flags[body] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = true;
        }
      }
    } else if (command === null) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

/** Read a flag as a non-empty string, or `undefined` if absent/boolean/empty. */
export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

/** Read a flag as a boolean (present-as-true or explicit true). */
export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
