import type { JSX } from 'react';
import { Page, PlaceholderNote } from './Page.tsx';

export function SettingsPage(): JSX.Element {
  return (
    <Page title="Settings" subtitle="Org, mailbox, and compliance configuration.">
      <PlaceholderNote>The settings surfaces land in a later phase.</PlaceholderNote>
    </Page>
  );
}
