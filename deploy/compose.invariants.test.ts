import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import {
  loadCompose,
  parseImageRef,
  REPO_ROOT,
  type ComposeModel,
  type ServiceModel,
} from './compose-model.ts';
import { loadDockerfile, isNonRootUser } from './dockerfile-model.ts';

/**
 * Compose-invariants suite (task 5f, ARCHITECTURE §8). Static analysis only — no
 * Docker daemon, no DB, no network. It parses deploy/docker-compose.yml and the
 * two Dockerfiles and asserts the deploy contract: the right services exist, every
 * long-lived service is health-checked and resource-limited, images are pinned
 * (never :latest), containers run non-root, the data stores stay internal, and
 * Postgres archives WAL to a second volume. The live bring-up drill a human runs
 * is deploy/VERIFY.md.
 */

const CORE_SERVICES = ['api', 'web', 'postgres', 'redis'] as const;

let compose: ComposeModel;

beforeAll(() => {
  compose = loadCompose();
});

function svc(name: string): ServiceModel {
  const s = compose.service(name);
  if (s === undefined) throw new Error(`expected service '${name}' in docker-compose.yml`);
  return s;
}

describe('compose — structure', () => {
  it('parses to a services mapping', () => {
    expect(compose.services.length).toBeGreaterThan(0);
  });

  it('defines the core stack (api, web, postgres, redis)', () => {
    for (const name of CORE_SERVICES) {
      expect(compose.serviceNames, `missing service ${name}`).toContain(name);
    }
  });

  it('declares the named data volumes (db data, WAL archive, redis AOF)', () => {
    expect(compose.volumeNames).toEqual(expect.arrayContaining(['pgdata', 'pgwal', 'redisdata']));
  });
});

describe('compose — images are pinned, never :latest', () => {
  it('every service image has an explicit non-latest tag', () => {
    for (const s of compose.services) {
      if (s.image === undefined) continue; // build-only services are covered by Dockerfile tests
      const ref = s.imageRef ?? parseImageRef(s.image);
      expect(ref.tag, `${s.name} image '${s.image}' has no tag`).toBeDefined();
      expect(ref.tag, `${s.name} image '${s.image}' uses a moving/implicit latest tag`).not.toBe(
        'latest',
      );
      expect(s.image.toLowerCase()).not.toContain(':latest');
    }
  });

  it('pins the pinned-major bases the task calls out', () => {
    expect(parseImageRef(svc('postgres').image ?? '').tag).toBe('16');
    expect(parseImageRef(svc('redis').image ?? '').tag).toBe('7');
  });
});

describe('compose — every service is health-checked', () => {
  it('has a healthcheck with test + interval + timeout + retries', () => {
    for (const s of compose.services) {
      const hc = s.healthcheck;
      expect(hc, `${s.name} has no healthcheck`).toBeDefined();
      if (hc === undefined) continue;
      expect(hc.hasTest, `${s.name} healthcheck has no test`).toBe(true);
      expect(hc.interval, `${s.name} healthcheck missing interval`).toBeDefined();
      expect(hc.timeout, `${s.name} healthcheck missing timeout`).toBeDefined();
      expect(hc.retries, `${s.name} healthcheck missing retries`).toBeDefined();
    }
  });

  it('the api liveness probe targets /healthz (§8)', () => {
    expect(svc('api').healthcheck?.test).toContain('/healthz');
  });

  it('postgres and redis probe with their native tools', () => {
    expect(svc('postgres').healthcheck?.test).toContain('pg_isready');
    expect(svc('redis').healthcheck?.test).toContain('redis-cli');
  });
});

describe('compose — dependency ordering by health', () => {
  it('api waits for postgres AND redis to be healthy', () => {
    const dep = svc('api').dependsOn;
    expect(dep['postgres']).toBe('service_healthy');
    expect(dep['redis']).toBe('service_healthy');
  });

  it('web waits for the api to be healthy', () => {
    expect(svc('web').dependsOn['api']).toBe('service_healthy');
  });
});

describe('compose — restart policies and resource limits', () => {
  it('every service restarts unless stopped (or always)', () => {
    for (const s of compose.services) {
      expect(['unless-stopped', 'always'], `${s.name} restart='${s.restart}'`).toContain(s.restart);
    }
  });

  it('every service caps memory (sane for a small VM)', () => {
    for (const s of compose.services) {
      expect(s.memoryLimit, `${s.name} has no memory limit`).toBeDefined();
    }
  });
});

describe('compose — data stores stay internal (no host port exposure)', () => {
  it('postgres publishes no host ports', () => {
    expect(svc('postgres').ports).toEqual([]);
  });
  it('redis publishes no host ports', () => {
    expect(svc('redis').ports).toEqual([]);
  });
  it('web is the published front door', () => {
    expect(svc('web').ports.length).toBeGreaterThan(0);
  });
});

describe('compose — postgres durability (WAL archiving to a second volume)', () => {
  it('enables WAL archiving in the launch command', () => {
    const pg = svc('postgres');
    const launch = `${pg.entrypoint} ${pg.command}`;
    expect(launch).toContain('wal_level=replica');
    expect(launch).toContain('archive_mode=on');
    expect(launch).toContain('archive_command');
  });

  it('mounts a data volume AND a separate WAL-archive volume', () => {
    const vols = svc('postgres').volumes.join('\n');
    expect(vols).toContain('pgdata:');
    expect(vols).toContain('pgwal:');
    expect(vols).toContain('wal-archive');
  });
});

describe('compose — redis persistence', () => {
  it('runs append-only with a data volume', () => {
    const redis = svc('redis');
    expect(redis.command).toContain('appendonly');
    expect(redis.volumes.join('\n')).toContain('redisdata:');
  });
});

describe('compose — api wiring', () => {
  it('runs the server role in production and migrates on boot', () => {
    const env = svc('api').environment;
    expect(env['NODE_ENV']).toBe('production');
    expect(env['APP_ROLE']).toBe('server');
    expect(env['MIGRATE_ON_BOOT']).toBeDefined();
  });

  it('points DATABASE_URL/REDIS_URL at the in-cluster services', () => {
    const env = svc('api').environment;
    expect(env['DATABASE_URL']).toContain('@postgres:5432/');
    expect(env['REDIS_URL']).toContain('redis:6379');
  });

  it('builds from apps/api/Dockerfile', () => {
    expect(JSON.stringify(svc('api').raw['build'])).toContain('apps/api/Dockerfile');
  });
});

describe('compose — worker role (profile-gated, same image as api)', () => {
  it('is gated behind the "worker" profile and does not migrate', () => {
    const worker = compose.service('worker');
    expect(worker).toBeDefined();
    if (worker === undefined) return;
    expect(worker.profiles).toContain('worker');
    expect(worker.environment['APP_ROLE']).toBe('worker');
    expect(worker.environment['MIGRATE_ON_BOOT']).toBe('0');
    expect(worker.image).toBe(svc('api').image); // one image, role by env
  });
});

// ---------------------------------------------------------------------------
// Dockerfile invariants
// ---------------------------------------------------------------------------

describe('Dockerfile — apps/api', () => {
  const df = () => loadDockerfile(resolve(REPO_ROOT, 'apps/api/Dockerfile'));

  it('is multi-stage', () => {
    expect(df().stageCount).toBeGreaterThanOrEqual(2);
  });

  it('runs as a non-root user', () => {
    const user = df().finalUser;
    expect(user, 'no USER directive').toBeDefined();
    expect(isNonRootUser(user), `final USER '${user}' is root`).toBe(true);
  });

  it('pins every base image (no :latest)', () => {
    for (const ref of df().baseImages) {
      expect(ref.tag, `base '${ref.raw}' has no tag`).toBeDefined();
      expect(ref.tag).not.toBe('latest');
    }
  });

  it('sets NODE_ENV=production and boots through the entrypoint gate', () => {
    const text = df().text;
    expect(text).toMatch(/NODE_ENV=production/);
    expect(text).toContain('entrypoint.sh');
    expect(text).toContain('migrate.mjs');
  });

  it('declares a /healthz HEALTHCHECK', () => {
    const text = df().text;
    expect(text).toContain('HEALTHCHECK');
    expect(text).toContain('/healthz');
  });
});

describe('Dockerfile — apps/web', () => {
  const df = () => loadDockerfile(resolve(REPO_ROOT, 'apps/web/Dockerfile'));

  it('is multi-stage', () => {
    expect(df().stageCount).toBeGreaterThanOrEqual(2);
  });

  it('runs nginx as a non-root user', () => {
    const user = df().finalUser;
    expect(user, 'no USER directive').toBeDefined();
    expect(isNonRootUser(user), `final USER '${user}' is root`).toBe(true);
  });

  it('pins every base image (no :latest)', () => {
    for (const ref of df().baseImages) {
      expect(ref.tag, `base '${ref.raw}' has no tag`).toBeDefined();
      expect(ref.tag).not.toBe('latest');
    }
  });

  it('builds the SPA in real-API mode and installs the nginx config', () => {
    const text = df().text;
    expect(text).toContain('VITE_API_MODE=real');
    expect(text).toContain('nginx.conf');
  });

  it('serves from an unprivileged nginx base', () => {
    const bases = df().baseImages.map((r) => r.name);
    expect(bases.some((n) => n.includes('nginx-unprivileged'))).toBe(true);
  });
});
