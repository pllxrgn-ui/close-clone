/**
 * Contacts engine service (CONTRACTS §C1/§C7). Real production read/write
 * surface behind `routes/contacts.ts`. Contact writes are event-free except DNC,
 * which routes through the ActivityWriter (contact-scoped `dnc_set`/`dnc_cleared`).
 */
export {
  InvalidContactLeadError,
  createContact,
  getContact,
  listContactsByLead,
  softDeleteContact,
  updateContact,
  type CreateContactInput,
  type UpdateContactInput,
  type WriteActor,
} from './service.ts';
