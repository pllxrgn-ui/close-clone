import type { JSX } from 'react';
import type { Contact } from '@switchboard/shared';
import { Button, Skeleton, StatusPill } from '../../../ui/index.ts';
import { initials } from '../../../lib/format.ts';

/*
 * Read-only contacts card for the lead's right rail. No mutation affordances —
 * editing/adding contacts is a later phase; this reflects GET /contacts?leadId=.
 */

interface LeadContactsCardProps {
  contacts: Contact[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function LeadContactsCard({
  contacts,
  isLoading,
  isError,
  onRetry,
}: LeadContactsCardProps): JSX.Element {
  return (
    <section className="rail-card" aria-label="Contacts">
      <header className="rail-card__head">
        <h2 className="rail-card__title">Contacts</h2>
        {!isLoading && !isError ? (
          <span className="rail-card__count">{contacts.length}</span>
        ) : null}
      </header>

      {isLoading ? (
        <div className="rail-card__body" aria-hidden="true">
          <Skeleton height={38} />
          <Skeleton height={38} />
        </div>
      ) : isError ? (
        <div className="rail-card__error" role="alert">
          <span>Couldn’t load contacts.</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : contacts.length === 0 ? (
        <p className="rail-card__empty">No contacts on this lead.</p>
      ) : (
        <ul className="rail-card__list">
          {contacts.map((contact) => {
            const email = contact.emails[0]?.email;
            const phone = contact.phones[0]?.phone;
            return (
              <li key={contact.id} className="contact-row">
                <span className="contact-row__avatar" aria-hidden="true">
                  {initials(contact.name)}
                </span>
                <div className="contact-row__body">
                  <div className="contact-row__name-line">
                    <span className="contact-row__name">{contact.name}</span>
                    {contact.dnc ? (
                      <StatusPill tone="dnc" dot>
                        DNC
                      </StatusPill>
                    ) : null}
                  </div>
                  {contact.title ? (
                    <span className="contact-row__title">{contact.title}</span>
                  ) : null}
                  {email ? (
                    <a className="contact-row__link" href={`mailto:${email}`}>
                      {email}
                    </a>
                  ) : null}
                  {phone ? <span className="contact-row__phone">{phone}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
