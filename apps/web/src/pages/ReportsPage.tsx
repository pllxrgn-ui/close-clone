import type { JSX } from 'react';
import { Page, PlaceholderNote } from './Page.tsx';

export function ReportsPage(): JSX.Element {
  return (
    <Page title="Reports" subtitle="Pipeline and activity analytics.">
      <PlaceholderNote>The reporting surfaces land in a later phase.</PlaceholderNote>
    </Page>
  );
}
