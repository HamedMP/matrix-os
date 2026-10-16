/**
 * Matrix sources (spec 559): the owner's notes, files and opted-in chats as Company Brain sources. Each handler plugs
 * into the sources service (sources/core); the readers are thin views over existing owner services.
 */
export { bootstrapBrainMatrixDatabase, BRAIN_MATRIX_KINDS, type BrainMatrixKind } from "./database.js";
export { createBrainMatrixNotesHandler, createBrainMatrixNotesReader } from "./notes.js";
export { createBrainMatrixFilesHandler } from "./files.js";
export { createBrainMatrixChatHandler } from "./chat.js";
export {
  BRAIN_MATRIX_LIMITS, type BrainMatrixBotChats, type BrainMatrixChatHandlerDeps, type BrainMatrixChatReader,
  type BrainMatrixFilesHandlerDeps, type BrainMatrixNotesHandlerDeps, type BrainMatrixNotesReader,
} from "./types.js";
