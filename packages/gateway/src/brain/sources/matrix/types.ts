/**
 * Matrix sources (notes, files, chats): the seams each adapter reads through, the limits every pass keeps and the
 * error the folder throws internally. The readers are thin views over existing services (the owner app database for
 * notes, ChatRepository for chats); files are read from home with the containment rules in files-walk.ts.
 */
import type { Kysely } from "kysely";
import type { BrainDatabase } from "../../types.js";

/** One note row, bounded by the reader's SQL: title and tags cut, content cut to NOTE_CONTENT_READ_MAX_CHARS. */
export interface BrainMatrixNoteRow {
  readonly id: string;
  readonly title: string | null;
  readonly content: string | null;
  /** Comma-joined tags as the Notes app stores them, cut to the reader's tags bound (label refs only). */
  readonly tags: string | null;
  /** Whether any tag of the whole column, past the tags bound too, is one of the folders asked for. */
  readonly selected: boolean;
  readonly updatedAt: string;
  /** True when content was longer than what the reader returned. */
  readonly contentCut: boolean;
}
export interface BrainMatrixNoteKey { readonly id: string; readonly selected: boolean }

/** Reads the owner's Notes app rows, ordered by id, never more than `limit`; `folders` decides `selected`. */
export interface BrainMatrixNotesReader {
  listNotes(after: string, limit: number, folders: readonly string[]): Promise<readonly BrainMatrixNoteRow[]>;
  listNoteKeys(after: string, limit: number, folders: readonly string[]): Promise<readonly BrainMatrixNoteKey[]>;
}

/** The subset of a committed chat message the chat adapter reads. */
export interface BrainMatrixChatMessage {
  readonly seq: number;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly state: "pending" | "committed" | "failed";
  readonly actorId?: string;
  readonly parts: readonly { readonly type: string; readonly text?: string }[];
  readonly createdAt: string;
}
export interface BrainMatrixChatRecord {
  readonly chat: { readonly id: string; readonly title: string; readonly activityAt?: string; readonly updatedAt: string };
}
export interface BrainMatrixChatOwner { readonly type: "personal"; readonly ownerId: string }
export interface BrainMatrixChatListPage {
  readonly items: readonly BrainMatrixChatRecord[];
  readonly nextCursor?: { readonly activityAt: string; readonly chatId: string };
}

/** Structurally a subset of ChatRepository, so the owner's repository is passed as is. */
export interface BrainMatrixChatReader {
  get(owner: BrainMatrixChatOwner, chatId: string): Promise<BrainMatrixChatRecord | null>;
  getMessages(owner: BrainMatrixChatOwner, chatId: string, input: { afterSeq: number; limit: number }):
    Promise<readonly BrainMatrixChatMessage[]>;
  list(owner: BrainMatrixChatOwner, input: {
    limit: number; lifecycle?: "active" | "archived"; cursor?: { activityAt: string; chatId: string };
  }): Promise<BrainMatrixChatListPage>;
}

export interface BrainMatrixHandlerBaseDeps {
  readonly kysely: Kysely<BrainDatabase>;
  readonly now?: () => Date;
}
/** Notes and files are the gateway owner's, not the caller's: only these principals may read them. */
export interface BrainMatrixOwnedHandlerDeps extends BrainMatrixHandlerBaseDeps {
  /**
   * Principals that may read the gateway's Notes or home: its configured owner. Absent or empty: nobody, so a
   * collaborator never copies them into a project of their own. Anyone else reads not_configured and gets no adapter.
   */
  readonly ownerIds?: readonly string[];
}
export interface BrainMatrixNotesHandlerDeps extends BrainMatrixOwnedHandlerDeps {
  /** Null when the owner database has no app storage: the kind answers not_configured. */
  readonly notes: BrainMatrixNotesReader | null;
}
export interface BrainMatrixFilesHandlerDeps extends BrainMatrixOwnedHandlerDeps {
  /** The Matrix home; every root is relative to it. */
  readonly homePath: string;
}
/**
 * The Chats among `chatIds` that are a Bot's own (a live direct or thread binding, the Company Brain's included). A Bot
 * answers from tool results other people wrote, so the brain never reads those answers back as chat evidence.
 */
export type BrainMatrixBotChats = (ownerId: string, chatIds: readonly string[]) => Promise<ReadonlySet<string>>;

export interface BrainMatrixChatHandlerDeps extends BrainMatrixHandlerBaseDeps {
  readonly chats: BrainMatrixChatReader | null;
  /** Bot Chats are never offered or read; absent: no Chat is a Bot's (a gateway without Bots). */
  readonly botChats?: BrainMatrixBotChats;
}

export const BRAIN_MATRIX_LIMITS = {
  /** Notes read per pass (first by id); the rest are left out with items_truncated. */
  notesPerPass: 5_000,
  notesPageMax: 100,
  noteContentReadMaxChars: 70_000,
  noteFolders: 20,
  /** Files: directory depth below a root, entries read per directory, entries examined and bytes read per page. */
  fileDepthMax: 12,
  dirEntriesMax: 5_000,
  fileEntriesPerPage: 5_000,
  /**
   * Directory entries read per page, skipped names included. More than fileDepthMax * (dirEntriesMax + 1): a page that
   * resumes reads at most fileDepthMax folders on the way back to its position and still has room to move on, and a
   * sweep page has room to check the folders of one whole file.
   */
  dirReadsPerPage: 65_000,
  fileBytesPerPage: 16 * 1024 * 1024,
  /** Chats: messages read per page, per day, parts per day, bytes per part, characters per message. */
  chatReadsPerPage: 4_200,
  chatMessagesPerDay: 2_000,
  chatPartsPerDay: 8,
  chatPartMaxBytes: 60_000,
  chatMessageMaxChars: 8_000,
  chatMessagesPerCall: 200,
  /** Sweep: store documents checked per page. */
  sweepPageMax: 100,
} as const;

/** Refused path or root: the run ends with path_unsafe and writes nothing for that page. */
export class BrainMatrixPathError extends Error {
  constructor(options?: ErrorOptions) {
    super("Matrix source path refused", options);
    this.name = "BrainMatrixPathError";
  }
}

/** A reader (app database, chat repository) failed: the run ends with provider_unavailable. */
export class BrainMatrixReaderError extends Error {
  constructor(options?: ErrorOptions) {
    super("Matrix source read failed", options);
    this.name = "BrainMatrixReaderError";
  }
}
