import type { JSX } from 'react';
import { Page, PlaceholderNote } from './Page.tsx';

export function LeadsPage(): JSX.Element {
  return (
    <Page title="Leads" subtitle="Every account, filterable by state.">
      <PlaceholderNote>
        The virtualized leads table and Smart View filters land in a later phase.
      </PlaceholderNote>
    </Page>
  );
}
