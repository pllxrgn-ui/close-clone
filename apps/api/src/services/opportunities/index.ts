/**
 * Opportunities CRUD service barrel (CONTRACTS §C7 `opportunities`). The route
 * plugin (`routes/opportunities.ts`) is the only caller; every write emits its
 * C4 event through the ActivityWriter in-transaction.
 */
export {
  OpportunityError,
  OpportunityNotFoundError,
  OpportunityLeadNotFoundError,
  InvalidReferenceError,
  InvalidOpportunityCursorError,
  serializeOpportunity,
  listOpportunities,
  listOpportunitiesByLead,
  getOpportunity,
  createOpportunity,
  patchOpportunity,
  deleteOpportunity,
  type ListOpportunitiesOptions,
  type OpportunityPage,
  type CreateOpportunityInput,
  type PatchOpportunityInput,
} from './service.ts';
