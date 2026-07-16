/**
 * AI features (tasks 3e/3g) — all confirm-before-commit (CONTRACTS §I-AI,
 * ARCHITECTURE §7). Call summaries write a DRAFT note and require an explicit
 * confirm (carrying confirmedBy) to reach `final` + a timeline event; email drafts
 * are returned to the composer and never auto-sent; NL→Smart View re-parses the
 * model's DSL with the shared parser and returns an AST for the builder to confirm.
 */

export {
  generateCallSummaryDraft,
  confirmCallSummary,
  CallSummaryError,
  CallNotFoundError,
  NoTranscriptSourceError,
  SummaryNoteNotFoundError,
  NotAiNoteError,
  SummaryAlreadyFinalError,
  type GenerateCallSummaryDeps,
  type GenerateCallSummaryInput,
  type CallSummaryDraft,
  type ConfirmCallSummaryDeps,
  type ConfirmCallSummaryInput,
  type ConfirmCallSummaryResult,
} from './call-summary.ts';

export {
  draftEmailForComposer,
  EmailDraftError,
  type DraftEmailDeps,
  type DraftEmailInput,
} from './email-draft.ts';

export {
  nlToSmartView,
  NlToSmartViewError,
  type NlToSmartViewDeps,
  type NlToSmartViewInput,
  type NlToSmartViewResult,
  type NlToSmartViewOk,
  type NlToSmartViewInvalid,
} from './nl-to-smart-view.ts';
