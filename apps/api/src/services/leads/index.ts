/**
 * Leads engine service (CONTRACTS §C1/§C4/§C7). Real production read/write
 * surface behind `routes/leads.ts` — the ActivityWriter is the sole path to the
 * `activities` spine, so every mutating verb emits its C4 event through it.
 */
export {
  InvalidLeadReferenceError,
  MAX_LIMIT,
  createLead,
  decodeLeadCursor,
  getLead,
  getLeadTimeline,
  listLeads,
  softDeleteLead,
  updateLead,
  type CreateLeadInput,
  type ListLeadsParams,
  type Page,
  type TimelineParams,
  type UpdateLeadInput,
  type WriteActor,
} from './service.ts';
