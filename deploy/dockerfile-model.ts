import { readFileSync } from 'node:fs';
import { parseImageRef, type ImageRef } from './compose-model.ts';

/**
 * Minimal Dockerfile reader for the invariants test: resolves ARG-defaulted FROM
 * images, tracks build stages so intra-file stage references aren't mistaken for
 * external base images, and records USER directives (last one wins → the runtime
 * user). Enough to assert multi-stage, pinned (non-latest) bases, and non-root.
 */

export interface FromLine {
  raw: string;
  image: string; // ARG-resolved
  stageName: string | undefined;
  isStageRef: boolean; // true when `image` names an earlier stage, not a registry image
}

export interface DockerfileModel {
  text: string;
  args: Record<string, string>;
  from: FromLine[];
  /** External (registry) base images only — stage-to-stage refs excluded. */
  baseImages: ImageRef[];
  users: string[];
  finalUser: string | undefined;
  stageCount: number;
}

function resolveArgs(image: string, args: Record<string, string>): string {
  return image.replace(
    /\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g,
    (_m, name: string, fallback?: string) => {
      return args[name] ?? fallback ?? '';
    },
  );
}

export function loadDockerfile(path: string): DockerfileModel {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const args: Record<string, string> = {};
  const from: FromLine[] = [];
  const users: string[] = [];
  const stageNames = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const argMatch = /^ARG\s+([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/i.exec(trimmed);
    if (argMatch) {
      const name = argMatch[1];
      const value = argMatch[2];
      if (name !== undefined && value !== undefined) {
        args[name] = value.replace(/^["']|["']$/g, '');
      }
      continue;
    }

    const fromMatch = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(trimmed);
    if (fromMatch) {
      const rawImage = fromMatch[1] ?? '';
      const stageName = fromMatch[2];
      const resolved = resolveArgs(rawImage, args);
      const isStageRef = stageNames.has(resolved);
      from.push({ raw: trimmed, image: resolved, stageName, isStageRef });
      if (stageName !== undefined) stageNames.add(stageName);
      continue;
    }

    const userMatch = /^USER\s+(\S+)/i.exec(trimmed);
    if (userMatch && userMatch[1] !== undefined) {
      users.push(resolveArgs(userMatch[1], args));
    }
  }

  const baseImages = from.filter((f) => !f.isStageRef).map((f) => parseImageRef(f.image));

  return {
    text,
    args,
    from,
    baseImages,
    users,
    finalUser: users.length > 0 ? users[users.length - 1] : undefined,
    stageCount: from.length,
  };
}

const ROOT_USERS = new Set(['root', '0', '0:0', 'root:root']);

export function isNonRootUser(user: string | undefined): boolean {
  if (user === undefined) return false;
  const id = user.split(':')[0] ?? user;
  return !ROOT_USERS.has(user) && id !== 'root' && id !== '0';
}
