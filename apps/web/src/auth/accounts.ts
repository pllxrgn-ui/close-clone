import type { User } from '@switchboard/shared';

/*
 * Personal DEMO accounts (mock mode only — real mode is OIDC/SSO and never
 * mounts this). Sign up with a username + password; the account and its
 * salted SHA-256 password hash live in THIS browser's localStorage, and each
 * account owns its own persistent blank workspace (see mocks/workspace.ts).
 *
 * Honest scope: this is a demo-grade account system, not a security boundary —
 * there is no server, so anything client-side is inspectable. It exists so the
 * demo FEELS like a real product (your own login, your own data) until the
 * real OIDC + Postgres deployment takes over.
 */

export interface DemoAccount {
  username: string;
  name: string;
  userId: string;
  salt: string;
  passHash: string;
  createdAt: string;
}

const ACCOUNTS_KEY = 'sb-accounts-v1';

export const USERNAME_RE = /^[a-z0-9_.-]{3,24}$/;
export const MIN_PASSWORD_LENGTH = 6;

function readAccounts(): DemoAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DemoAccount[]) : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: DemoAccount[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    /* storage unavailable — account creation will appear to not stick */
  }
}

export function findAccount(username: string): DemoAccount | null {
  const needle = username.trim().toLowerCase();
  return readAccounts().find((a) => a.username === needle) ?? null;
}

async function hashPassword(salt: string, password: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The app-facing User for a demo account — admin of their own solo org. */
export function accountUser(account: DemoAccount): User {
  return {
    id: account.userId,
    email: `${account.username}@switchboard.local`,
    name: account.name,
    role: 'admin',
    idpSubject: `demo:${account.username}`,
    isActive: true,
    timezone: 'America/Los_Angeles',
    createdAt: account.createdAt,
    updatedAt: account.createdAt,
  };
}

export type CreateAccountResult =
  | { ok: true; account: DemoAccount }
  | { ok: false; error: 'username_taken' | 'invalid_username' | 'weak_password' | 'name_required' };

export async function createAccount(input: {
  name: string;
  username: string;
  password: string;
}): Promise<CreateAccountResult> {
  const name = input.name.trim();
  const username = input.username.trim().toLowerCase();
  if (name.length === 0) return { ok: false, error: 'name_required' };
  if (!USERNAME_RE.test(username)) return { ok: false, error: 'invalid_username' };
  if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: 'weak_password' };
  if (findAccount(username)) return { ok: false, error: 'username_taken' };

  const salt = crypto.randomUUID();
  const account: DemoAccount = {
    username,
    name,
    userId: crypto.randomUUID(),
    salt,
    passHash: await hashPassword(salt, input.password),
    createdAt: new Date().toISOString(),
  };
  writeAccounts([...readAccounts(), account]);
  return { ok: true, account };
}

export type VerifyResult =
  { ok: true; account: DemoAccount } | { ok: false; error: 'unknown_account' | 'wrong_password' };

export async function verifyAccount(username: string, password: string): Promise<VerifyResult> {
  const account = findAccount(username);
  if (!account) return { ok: false, error: 'unknown_account' };
  const hash = await hashPassword(account.salt, password);
  if (hash !== account.passHash) return { ok: false, error: 'wrong_password' };
  return { ok: true, account };
}
