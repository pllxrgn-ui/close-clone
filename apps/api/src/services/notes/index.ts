/**
 * Notes CRUD service barrel (CONTRACTS §C7 `notes`). The route plugin
 * (`routes/notes.ts`) is the only caller. §I-AI: this service writes human notes
 * only and never finalizes an AI-generated note (that path is the AI confirm
 * route in `services/ai` / `routes/ai.ts`).
 */
export {
  NoteError,
  NoteNotFoundError,
  NoteLeadNotFoundError,
  InvalidNoteReferenceError,
  AiNoteFinalizeError,
  serializeNote,
  listNotesByLead,
  getNote,
  createNote,
  patchNote,
  deleteNote,
  type CreateNoteInput,
  type PatchNoteInput,
} from './service.ts';
