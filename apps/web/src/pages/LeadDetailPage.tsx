import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import { Page, PlaceholderNote } from './Page.tsx';

export function LeadDetailPage(): JSX.Element {
  const { id } = useParams();
  return (
    <Page
      title="Lead"
      subtitle={
        <>
          Lead <code>{id}</code>
        </>
      }
    >
      <PlaceholderNote>
        The lead timeline, contacts, opportunities, and composer land in a later phase.
      </PlaceholderNote>
    </Page>
  );
}
