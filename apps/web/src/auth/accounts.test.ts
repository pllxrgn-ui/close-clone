import { beforeEach, describe, expect, test } from 'vitest';
import { accountUser, createAccount, findAccount, verifyAccount } from './accounts.ts';

beforeEach(() => localStorage.clear());

describe('demo accounts (mock-mode username + password)', () => {
  test('sign-up stores a salted hash — never the plaintext password', async () => {
    const result = await createAccount({ name: 'Pol V', username: 'Pol', password: 'hunter22' });
    expect(result.ok).toBe(true);
    const stored = localStorage.getItem('sb-accounts-v1') ?? '';
    expect(stored).not.toContain('hunter22');
    // Username normalizes to lowercase.
    expect(findAccount('POL')?.username).toBe('pol');
    expect(findAccount('pol')?.passHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('validation: bad usernames, weak passwords, missing name, duplicates', async () => {
    expect((await createAccount({ name: 'A', username: 'x', password: 'longenough' })).ok).toBe(
      false,
    );
    expect(
      (await createAccount({ name: 'A', username: 'has space', password: 'longenough' })).ok,
    ).toBe(false);
    expect((await createAccount({ name: 'A', username: 'okname', password: 'tiny' })).ok).toBe(
      false,
    );
    expect(
      (await createAccount({ name: '  ', username: 'okname', password: 'longenough' })).ok,
    ).toBe(false);
    expect(
      (await createAccount({ name: 'A', username: 'okname', password: 'longenough' })).ok,
    ).toBe(true);
    const dupe = await createAccount({ name: 'B', username: 'OKNAME', password: 'different1' });
    expect(dupe).toEqual({ ok: false, error: 'username_taken' });
  });

  test('verify: right password in, wrong password out, unknown username named', async () => {
    await createAccount({ name: 'Pol V', username: 'pol', password: 'hunter22' });
    expect((await verifyAccount('pol', 'hunter22')).ok).toBe(true);
    expect(await verifyAccount('pol', 'wrong')).toEqual({ ok: false, error: 'wrong_password' });
    expect(await verifyAccount('ghost', 'x')).toEqual({ ok: false, error: 'unknown_account' });
  });

  test('accountUser builds a valid solo-org admin from the account', async () => {
    const created = await createAccount({ name: 'Pol V', username: 'pol', password: 'hunter22' });
    if (!created.ok) throw new Error('setup failed');
    const user = accountUser(created.account);
    expect(user.role).toBe('admin');
    expect(user.name).toBe('Pol V');
    expect(user.email).toBe('pol@switchboard.local');
    expect(user.id).toBe(created.account.userId);
  });
});
