/**
 * Templates + snippets services (task 2d, CONTRACTS §C1). Templates are
 * channel-scoped and owner/shared; snippets are personal. Both are owner-guarded
 * with a valid-active-actor requirement (RBAC-safe default). The merge renderer
 * (`services/email/merge.ts`) is what makes rendered field values injection-safe;
 * these services store bodies verbatim.
 */

export {
  InvalidActorError,
  InvalidCursorError,
} from './access.ts';
export {
  TemplateNotFoundError,
  TemplateForbiddenError,
  createTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  deleteTemplate,
  type TemplateChannel,
  type TemplateRow,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type ListTemplatesOptions,
  type ListTemplatesResult,
} from './templates.ts';
export {
  SnippetNotFoundError,
  createSnippet,
  getSnippet,
  listSnippets,
  updateSnippet,
  deleteSnippet,
  type SnippetRow,
  type CreateSnippetInput,
  type UpdateSnippetInput,
  type ListSnippetsOptions,
  type ListSnippetsResult,
} from './snippets.ts';
