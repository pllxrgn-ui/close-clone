import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import { Page, PlaceholderNote } from './Page.tsx';

export function ViewDetailPage(): JSX.Element {
  const { id } = useParams();
  return (
    <Page
      title="Smart View"
      subtitle={
        <>
          View <code>{id}</code>
        </>
      }
    >
      <PlaceholderNote>
        The Smart View results table and inline editor land in a later phase.
      </PlaceholderNote>
    </Page>
  );
}
