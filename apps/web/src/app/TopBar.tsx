import { useState } from 'react';
import type { JSX, RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import type { User } from '@switchboard/shared';
import { initials } from '../lib/format.ts';
import { Kbd } from '../ui/index.ts';
import { BoardMark } from '../ui/BoardMark.tsx';
import { CommandIcon, SearchIcon } from '../ui/icons.tsx';
import { KbdCombo } from '../keyboard/index.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

interface TopBarProps {
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenPalette: () => void;
}

export function TopBar({ searchRef, onOpenPalette }: TopBarProps): JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  return (
    <header className="sb-topbar">
      <div className="sb-topbar__brand">
        <BoardMark size={18} />
        <span className="sb-topbar__org">Switchboard</span>
        <span
          className="sb-topbar__demo"
          title="This is a demo build backed by synthetic sample data — no real accounts or messages."
        >
          Demo · sample data
        </span>
      </div>

      <form
        className="sb-topbar__search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) navigate(`/leads?q=${encodeURIComponent(query.trim())}`);
        }}
      >
        <SearchIcon size={15} className="sb-topbar__search-icon" />
        <input
          ref={searchRef}
          type="search"
          className="sb-input sb-topbar__search-input"
          placeholder="Search leads, contacts…"
          aria-label="Global search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Kbd className="sb-topbar__search-kbd">/</Kbd>
      </form>

      <div className="sb-topbar__right">
        <button
          type="button"
          className="sb-topbar__cmdk"
          aria-label="Open command palette"
          onClick={onOpenPalette}
        >
          <CommandIcon size={14} className="sb-topbar__cmdk-icon" />
          <span className="sb-topbar__cmdk-label">Command</span>
          <KbdCombo combo="mod+k" />
        </button>
        <ThemeToggle />
        {user ? (
          <UserMenu
            user={user}
            onSignOut={() => {
              logout();
              navigate('/login');
            }}
          />
        ) : null}
      </div>
    </header>
  );
}

function UserMenu({ user, onSignOut }: { user: User; onSignOut: () => void }): JSX.Element {
  return (
    <details className="sb-usermenu">
      <summary className="sb-usermenu__chip" aria-label={`Account: ${user.name}`}>
        <span className="sb-avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="sb-usermenu__name">{user.name}</span>
      </summary>
      <div className="sb-usermenu__panel">
        <div>
          <div className="sb-usermenu__meta-name">{user.name}</div>
          <div className="sb-usermenu__meta-email">{user.email}</div>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn--ghost sb-usermenu__signout"
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    </details>
  );
}
