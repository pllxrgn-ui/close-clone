import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme/ThemeProvider.tsx';
import { AuthProvider } from '../auth/AuthProvider.tsx';
import { createQueryClient } from './queryClient.ts';

/**
 * App-wide context stack (router-agnostic so tests can mount it around either a
 * BrowserRouter or a MemoryRouter): theme → react-query → auth.
 * The QueryClient is created once per provider instance.
 */
export function AppProviders({ children }: { children: ReactNode }): JSX.Element {
  const [queryClient] = useState(createQueryClient);
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
