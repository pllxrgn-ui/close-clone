import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEPLOY_DIR, REPO_ROOT } from './compose-model.ts';

/**
 * Script-safety smoke tests for the deploy kit (task 5f). Two layers:
 *   1. Static contract checks — the backup/restore/entrypoint/migrate scripts and
 *      the nginx config contain the safety-critical logic they must (pg_dump -Fc,
 *      N=14 rotation, restore-into-scratch + PASS/FAIL verdict, advisory-locked
 *      migrate, SPA fallback + security headers). These run everywhere.
 *   2. Real parser smoke — `bash -n` on the .sh scripts and a PowerShell parse of
 *      the .ps1 scripts, WHERE those interpreters exist (skipped otherwise). This
 *      is the "script logic smoke-tested where node-runnable" the task asks for;
 *      full execution needs Docker + Postgres and lives in deploy/VERIFY.md.
 */

const read = (rel: string): string => readFileSync(resolve(DEPLOY_DIR, rel), 'utf8');

function toolAvailable(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !(r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ENOENT');
}

const HAS_BASH = toolAvailable('bash', ['-c', 'exit 0']);
const PWSH = ['pwsh', 'powershell'].find((c) =>
  toolAvailable(c, ['-NoProfile', '-Command', 'exit 0']),
);

describe('backup scripts — pg_dump -Fc + N=14 rotation', () => {
  for (const file of ['scripts/backup.sh', 'scripts/backup.ps1']) {
    it(`${file}: dumps in custom format and rotates by retention`, () => {
      const text = read(file);
      expect(text).toContain('pg_dump');
      expect(text).toContain('-Fc');
      expect(text).toContain('14'); // default retention N=14
      expect(text.toLowerCase()).toContain('rotat');
      expect(text).toContain('pg_restore'); // integrity: pg_restore -l
    });
  }

  it('backup.sh is a strict bash script', () => {
    expect(read('scripts/backup.sh')).toContain('set -euo pipefail');
  });
});

describe('restore scripts — scripted drill into a scratch db', () => {
  for (const file of ['scripts/restore.sh', 'scripts/restore.ps1']) {
    it(`${file}: restores into a scratch db with a PASS/FAIL verdict`, () => {
      const text = read(file);
      expect(text).toContain('switchboard_restore_drill_'); // scratch db, not prod
      expect(text).toContain('pg_restore');
      expect(text).toContain('createdb');
      expect(text).toMatch(/count\(\*\)/); // row-count sanity query
      expect(text).toContain('PASS');
      expect(text).toContain('FAIL');
    });

    it(`${file}: never drops the production database`, () => {
      const text = read(file);
      // The only DROP path targets the scratch db.
      expect(text).not.toMatch(/drop\s*database/i);
      expect(text).not.toMatch(/dropdb[^\n]*PGDATABASE/i);
      expect(text).not.toMatch(/dropdb[^\n]*PgDatabase/);
    });
  }

  it('restore.sh is a strict bash script', () => {
    expect(read('scripts/restore.sh')).toContain('set -euo pipefail');
  });
});

describe('api entrypoint — migrate-then-serve, role by env', () => {
  const text = () => read('scripts/entrypoint.sh');

  it('is a strict POSIX sh script', () => {
    expect(text()).toMatch(/^#!\/bin\/sh/);
    expect(text()).toContain('set -eu');
  });

  it('selects behaviour by APP_ROLE and gates migrations on MIGRATE_ON_BOOT', () => {
    const t = text();
    expect(t).toContain('APP_ROLE');
    expect(t).toContain('MIGRATE_ON_BOOT');
    expect(t).toContain('server');
    expect(t).toContain('worker');
  });

  it('runs migrations then execs the TS server via type-stripping', () => {
    const t = text();
    expect(t).toContain('migrate.mjs');
    expect(t).toContain('--experimental-strip-types');
    expect(t).toContain('src/index.ts');
  });
});

describe('migrate runner — advisory-locked drizzle migrator', () => {
  const text = () => read('scripts/migrate.mjs');

  it('takes a Postgres advisory lock (single-writer v1)', () => {
    expect(text()).toContain('pg_advisory_lock');
    expect(text()).toContain('pg_advisory_unlock');
  });

  it('applies the repo migrations via drizzle-orm (no drizzle-kit in runtime)', () => {
    const t = text();
    expect(t).toContain('drizzle-orm/node-postgres/migrator');
    expect(t).toContain('migrationsFolder');
  });
});

describe('nginx — SPA fallback, gzip, security headers, api proxy', () => {
  const text = () => read('web/nginx.conf');

  it('serves the SPA with history-API fallback', () => {
    expect(text()).toContain('try_files');
    expect(text()).toContain('/index.html');
  });

  it('enables gzip', () => {
    expect(text()).toMatch(/gzip\s+on;/);
  });

  it('sets the core security headers', () => {
    const t = text();
    expect(t).toContain('X-Content-Type-Options');
    expect(t).toContain('nosniff');
    expect(t).toContain('X-Frame-Options');
    expect(t).toContain('Content-Security-Policy');
    expect(t).toContain('Referrer-Policy');
  });

  it('reverse-proxies the api REST + WS surface', () => {
    const t = text();
    expect(t).toContain('location /api/');
    expect(t).toContain('location /ws');
    expect(t).toContain('api:3000');
  });
});

// --- real parser smoke (conditional on interpreter availability) ---

describe('shell syntax — bash -n', () => {
  const shFiles = ['scripts/backup.sh', 'scripts/restore.sh', 'scripts/entrypoint.sh'];
  for (const file of shFiles) {
    it.skipIf(!HAS_BASH)(`${file} parses`, () => {
      const r = spawnSync('bash', ['-n', resolve(DEPLOY_DIR, file)], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    });
  }
});

describe('powershell syntax — Parser', () => {
  const psFiles = ['scripts/backup.ps1', 'scripts/restore.ps1'];
  for (const file of psFiles) {
    it.skipIf(PWSH === undefined)(`${file} parses`, () => {
      const abs = resolve(DEPLOY_DIR, file);
      const script = `try { [void][ScriptBlock]::Create((Get-Content -Raw -LiteralPath '${abs.replace(/'/g, "''")}')); exit 0 } catch { Write-Error $_; exit 1 }`;
      const r = spawnSync(
        PWSH ?? 'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
        },
      );
      expect(r.status, r.stderr).toBe(0);
    });
  }
});

describe('node runnable — migrate.mjs is importable/parseable', () => {
  it('migrate.mjs passes node --check', () => {
    const r = spawnSync(process.execPath, ['--check', resolve(DEPLOY_DIR, 'scripts/migrate.mjs')], {
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it('deploy dir sits under the repo root (path sanity)', () => {
    expect(DEPLOY_DIR.startsWith(REPO_ROOT)).toBe(true);
  });
});
