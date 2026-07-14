/**
 * Activity event stream (CONTRACTS §C4). The ActivityWriter is the only path
 * that writes the append-only `activities` spine and the only maintainer of the
 * C1 denormalized `leads` columns.
 */
export {
  ActivityWriter,
  ActivityWriterError,
  LeadNotFoundError,
  recordActivity,
  type RecordActivityInput,
} from './writer.ts';
