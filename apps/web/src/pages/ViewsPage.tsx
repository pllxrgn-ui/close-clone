import type { JSX } from 'react';
import { Page, PlaceholderNote } from './Page.tsx';

export function ViewsPage(): JSX.Element {
  return (
    <Page title="Views" subtitle="Saved Smart Views built on the query DSL.">
      <PlaceholderNote>
        The Smart View builder and DSL editor land in a later phase.
      </PlaceholderNote>
    </Page>
  );
}
