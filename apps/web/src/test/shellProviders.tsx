import type { JSX, ReactNode } from 'react';
import { KeyboardProvider } from '../keyboard/index.ts';
import { ToastProvider } from '../feedback/index.ts';
import { CommsProvider } from '../features/comms/index.ts';
import { CallProvider } from '../features/calling/index.ts';
import { SmsProvider } from '../features/sms/index.ts';
import { AiProvider } from '../features/ai/index.ts';

/**
 * Test-only mirror of the AppShell feature-provider stack
 * (Keyboard → Toast → Comms → Call → Sms → Ai). Lead/detail surfaces mount
 * launchers (call, SMS, email, AI call-summaries) that consume these contexts;
 * production supplies them via AppShell, so any test that renders a lead surface
 * in isolation must wrap it here.
 *
 * Assumes the caller provides QueryClient, a Router, and AuthProvider above it —
 * CallProvider and LeadCallSummaries read useAuth()/useToast().
 */
export function ShellFeatureProviders({ children }: { children: ReactNode }): JSX.Element {
  return (
    <KeyboardProvider>
      <ToastProvider>
        <CommsProvider>
          <CallProvider>
            <SmsProvider>
              <AiProvider>{children}</AiProvider>
            </SmsProvider>
          </CallProvider>
        </CommsProvider>
      </ToastProvider>
    </KeyboardProvider>
  );
}
