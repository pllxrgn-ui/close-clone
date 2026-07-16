import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * Typed reader/narrower for deploy/docker-compose.yml. `js-yaml` hands back
 * `unknown`; everything below narrows with explicit guards (no `any`) into a flat
 * shape the invariants test asserts against. Compose's several equivalent
 * spellings (map vs list for depends_on / environment / volumes; string vs list
 * for command / healthcheck.test) are normalised here so the test stays simple.
 */

export const DEPLOY_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(DEPLOY_DIR, '..');
export const COMPOSE_PATH = resolve(DEPLOY_DIR, 'docker-compose.yml');

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Join a string|list command/entrypoint/test into one string for text checks. */
function flatten(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v))
    return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  return '';
}

export interface ImageRef {
  raw: string;
  name: string;
  tag?: string;
  digest?: string;
}

/**
 * Split a Docker image reference into name/tag/digest. Handles registry ports
 * (`registry:5000/img`) by only treating a colon AFTER the last slash as a tag.
 */
export function parseImageRef(image: string): ImageRef {
  let s = image;
  let digest: string | undefined;
  const at = s.indexOf('@');
  if (at >= 0) {
    digest = s.slice(at + 1);
    s = s.slice(0, at);
  }
  const lastSlash = s.lastIndexOf('/');
  const lastColon = s.lastIndexOf(':');
  let tag: string | undefined;
  if (lastColon > lastSlash) {
    tag = s.slice(lastColon + 1);
    s = s.slice(0, lastColon);
  }
  return { raw: image, name: s, tag, digest };
}

export interface HealthcheckModel {
  raw: Record<string, unknown>;
  test: string;
  hasTest: boolean;
  interval: string | undefined;
  timeout: string | undefined;
  retries: number | undefined;
}

export interface ServiceModel {
  name: string;
  raw: Record<string, unknown>;
  image: string | undefined;
  imageRef: ImageRef | undefined;
  hasBuild: boolean;
  restart: string | undefined;
  profiles: string[];
  ports: string[];
  volumes: string[];
  command: string;
  entrypoint: string;
  environment: Record<string, string>;
  healthcheck: HealthcheckModel | undefined;
  dependsOn: Record<string, string | undefined>; // service -> condition
  memoryLimit: string | undefined;
  cpuLimit: string | undefined;
}

export interface ComposeModel {
  raw: Record<string, unknown>;
  text: string;
  services: ServiceModel[];
  serviceNames: string[];
  volumeNames: string[];
  service(name: string): ServiceModel | undefined;
}

function parsePorts(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((p) => {
    if (typeof p === 'string') return p;
    if (isRecord(p)) {
      const target = p['target'];
      const published = p['published'];
      return `${published ?? ''}:${target ?? ''}`;
    }
    return String(p);
  });
}

function parseVolumes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((vol) => {
    if (typeof vol === 'string') return vol;
    if (isRecord(vol)) {
      const source = vol['source'];
      const target = vol['target'];
      return `${source ?? ''}:${target ?? ''}`;
    }
    return String(vol);
  });
}

function parseEnvironment(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = val === null ? '' : String(val);
  } else if (Array.isArray(v)) {
    for (const item of v) {
      const s = asString(item);
      if (s === undefined) continue;
      const eq = s.indexOf('=');
      if (eq >= 0) out[s.slice(0, eq)] = s.slice(eq + 1);
      else out[s] = '';
    }
  }
  return out;
}

function parseDependsOn(v: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = asString(item);
      if (s !== undefined) out[s] = undefined;
    }
  } else if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) {
      out[k] = isRecord(val) ? asString(val['condition']) : undefined;
    }
  }
  return out;
}

function parseHealthcheck(v: unknown): HealthcheckModel | undefined {
  if (!isRecord(v)) return undefined;
  const test = flatten(v['test']);
  return {
    raw: v,
    test,
    hasTest: test.trim().length > 0 && flatten(v['test']) !== 'NONE',
    interval: asString(v['interval']),
    timeout: asString(v['timeout']),
    retries: typeof v['retries'] === 'number' ? v['retries'] : undefined,
  };
}

function parseLimits(deploy: unknown): { memory: string | undefined; cpus: string | undefined } {
  if (!isRecord(deploy)) return { memory: undefined, cpus: undefined };
  const resources = deploy['resources'];
  if (!isRecord(resources)) return { memory: undefined, cpus: undefined };
  const limits = resources['limits'];
  if (!isRecord(limits)) return { memory: undefined, cpus: undefined };
  return { memory: asString(limits['memory']), cpus: asString(limits['cpus']) };
}

function parseProfiles(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((p) => asString(p)).filter((p): p is string => p !== undefined);
}

function parseService(name: string, raw: Record<string, unknown>): ServiceModel {
  const image = asString(raw['image']);
  const limits = parseLimits(raw['deploy']);
  return {
    name,
    raw,
    image,
    imageRef: image !== undefined ? parseImageRef(image) : undefined,
    hasBuild: raw['build'] !== undefined,
    restart: asString(raw['restart']),
    profiles: parseProfiles(raw['profiles']),
    ports: parsePorts(raw['ports']),
    volumes: parseVolumes(raw['volumes']),
    command: flatten(raw['command']),
    entrypoint: flatten(raw['entrypoint']),
    environment: parseEnvironment(raw['environment']),
    healthcheck: parseHealthcheck(raw['healthcheck']),
    dependsOn: parseDependsOn(raw['depends_on']),
    memoryLimit: limits.memory ?? asString(raw['mem_limit']),
    cpuLimit: limits.cpus ?? asString(raw['cpus']),
  };
}

export function loadCompose(path: string = COMPOSE_PATH): ComposeModel {
  const text = readFileSync(path, 'utf8');
  const doc = load(text);
  if (!isRecord(doc)) throw new Error(`compose file did not parse to a mapping: ${path}`);
  const servicesRaw = doc['services'];
  if (!isRecord(servicesRaw)) throw new Error('compose file has no `services` mapping');

  const services: ServiceModel[] = [];
  for (const [name, raw] of Object.entries(servicesRaw)) {
    if (isRecord(raw)) services.push(parseService(name, raw));
  }

  const volumesRaw = doc['volumes'];
  const volumeNames = isRecord(volumesRaw) ? Object.keys(volumesRaw) : [];

  return {
    raw: doc,
    text,
    services,
    serviceNames: services.map((s) => s.name),
    volumeNames,
    service(name: string): ServiceModel | undefined {
      return services.find((s) => s.name === name);
    },
  };
}
