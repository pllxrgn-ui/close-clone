import { beforeEach, describe, expect, test } from 'vitest';
import type { JSX } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@switchboard/shared';
import { AUTH_STORAGE_KEY, readStoredUser, storeUser } from './auth.ts';
import { AuthProvider, useAuth } from './AuthProvider.tsx';

const SAMPLE: User = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ada@switchboard.test',
  name: 'Ada Okafor',
  role: 'admin',
  idpSubject: 'dev|ada@switchboard.test',
  isActive: true,
  timezone: 'America/New_York',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
});

describe('auth storage', () => {
  test('persists and restores a user', () => {
    storeUser(SAMPLE);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toContain('ada@switchboard.test');
    expect(readStoredUser()?.id).toBe(SAMPLE.id);
  });

  test('storeUser(null) clears the session', () => {
    storeUser(SAMPLE);
    storeUser(null);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(readStoredUser()).toBeNull();
  });

  // failure path: a corrupt / partial blob is not treated as a session
  test('ignores a corrupt stored value', () => {
    localStorage.setItem(AUTH_STORAGE_KEY, '{"id":123}');
    expect(readStoredUser()).toBeNull();
    localStorage.setItem(AUTH_STORAGE_KEY, 'not json at all');
    expect(readStoredUser()).toBeNull();
  });
});

function Probe(): JSX.Element {
  const { user, isAuthenticated, login, logout } = useAuth();
  return (
    <div>
      <output>{user ? `${user.name}:${String(isAuthenticated)}` : 'anon'}</output>
      <button type="button" onClick={() => login(SAMPLE)}>
        sign in
      </button>
      <button type="button" onClick={logout}>
        sign out
      </button>
    </div>
  );
}

describe('AuthProvider', () => {
  test('login sets the user and persists; logout clears it', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('anon');

    await userEvent.click(screen.getByRole('button', { name: 'sign in' }));
    expect(screen.getByRole('status')).toHaveTextContent('Ada Okafor:true');
    expect(readStoredUser()?.id).toBe(SAMPLE.id);

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(screen.getByRole('status')).toHaveTextContent('anon');
    expect(readStoredUser()).toBeNull();
  });

  test('restores an existing session on mount', () => {
    storeUser(SAMPLE);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Ada Okafor:true');
  });

  // failure path: the hook guards against use outside its provider
  test('useAuth throws outside an AuthProvider', () => {
    expect(() => render(<Probe />)).toThrow(/AuthProvider/);
  });
});
