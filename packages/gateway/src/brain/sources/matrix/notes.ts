/**
 * Matrix notes source: one matrix_note document per note of the owner's Notes app, read through the owner app
 * database with fixed, bounded SQL. `folders` selects notes by tag (the Notes app has tags, not folders); empty
 * means every note. Each run continues one full pass (scan by note id, then a sweep that tombstones documents of
 * notes that are gone or no longer selected). A page keeps within maxUpserts and maxRefs (a note carries at most
 * NOTE_REFS_MAX label refs).
 */
import { z } from "zod/v4";
import type {
  BrainMatrixNotesSourceConfig, BrainSourceAdapter, BrainSourceKindHandler, BrainSourceReadContext,
  BrainSourceReadResult,
} from "../../contracts.js";
import { identifyNotes, parseNotesConfig } from "./config.js";
import { loadMatrixConfig, saveMatrixConfig } from "./database.js";
import {
  MatrixPageDraft, cleanText, decodeMatrixCursor, documentTitle, encodeMatrixCursor, fitBody, guardRead, isoInstant,
  matrixDocumentId, sweepStep, readThrough,
} from "./shared.js";
import {
  BRAIN_MATRIX_LIMITS, type BrainMatrixNoteKey, type BrainMatrixNoteRow, type BrainMatrixNotesHandlerDeps,
  type BrainMatrixNotesReader,
} from "./types.js";

const KIND = "matrix_notes" as const;
const CURSOR_PREFIX = "mn1:";
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CursorSchema = z.discriminatedUnion("phase", [
  z.object({ v: z.literal(1), phase: z.literal("scan"), after: z.string().max(128), seen: z.number().int().min(0) })
    .strict(),
  z.object({ v: z.literal(1), phase: z.literal("sweep"), after: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
]);
type NotesCursor = z.infer<typeof CursorSchema>;
const START: NotesCursor = { v: 1, phase: "scan", after: "", seen: 0 };
/** Label refs per note; a page must have room for one note's refs. */
const NOTE_REFS_MAX = 20;

/**
 * Every tag as the Notes app writes them: comma or space separated, lowercase, without "#". Selection checks all of
 * them; only the refs are capped at NOTE_REFS_MAX.
 */
export function noteTags(tags: string | null): string[] {
  const out = new Set<string>();
  for (const raw of (tags ?? "").split(/[,\s]+/)) {
    const tag = raw.replace(/^#/, "").trim().toLowerCase();
    if (/^[a-z][a-z0-9-]{1,40}$/.test(tag)) out.add(tag);
  }
  return [...out];
}

function selected(config: BrainMatrixNotesSourceConfig, tags: string | null): boolean {
  if (config.folders.length === 0) return true;
  return noteTags(tags).some((tag) => config.folders.includes(tag));
}

function noteDocument(externalRef: string, note: BrainMatrixNoteRow) {
  const content = cleanText(note.content ?? "");
  const firstLine = content.trim().split("\n", 1)[0]!.replace(/^#+\s*/, "").slice(0, 120);
  const title = documentTitle(note.title ?? "", firstLine.trim() === "" ? "Untitled note" : firstLine);
  const fitted = fitBody(title, content.trim() === "" ? title : content);
  const refs = noteTags(note.tags).slice(0, NOTE_REFS_MAX).map((value) => ({ kind: "label", value }));
  return {
    cut: fitted.cut || note.contentCut,
    document: {
      documentId: matrixDocumentId(KIND, externalRef, [note.id]), title, body: fitted.body, permalink: "",
      sourceUpdatedAt: note.updatedAt, provenance: "matrix_note", refs,
    },
  };
}

async function scan(
  context: BrainSourceReadContext<BrainMatrixNotesSourceConfig>, reader: BrainMatrixNotesReader,
  cursor: Extract<NotesCursor, { phase: "scan" }>,
): Promise<BrainSourceReadResult> {
  const draft = new MatrixPageDraft(context);
  const room = BRAIN_MATRIX_LIMITS.notesPerPass - cursor.seen;
  const limit = Math.min(BRAIN_MATRIX_LIMITS.notesPageMax, context.limits.maxUpserts, room);
  const rows = limit > 0 ? await readThrough("notes read", () => reader.listNotes(cursor.after, limit)) : [];
  let after = cursor.after;
  let done = 0;
  for (const note of rows) {
    if (selected(context.config, note.tags)) {
      const { cut, document } = noteDocument(context.externalRef, note);
      // The next page starts at this note; readPage makes sure the first note of a page always fits.
      if (!draft.fits(1, document.refs.length)) break;
      if (cut) draft.notices.add("body_truncated");
      draft.upsert(document);
    } else {
      draft.skipped += 1;
    }
    after = note.id;
    done += 1;
  }
  const seen = cursor.seen + done;
  const more = done < rows.length || (rows.length === limit && seen < BRAIN_MATRIX_LIMITS.notesPerPass);
  if (!more && seen >= BRAIN_MATRIX_LIMITS.notesPerPass) draft.notices.add("items_truncated");
  const next: NotesCursor = more ? { v: 1, phase: "scan", after, seen } : { v: 1, phase: "sweep", after: null };
  return draft.page(encodeMatrixCursor(CURSOR_PREFIX, next), false);
}

/** Document ids of every selected note within the pass cap. */
async function selectedIds(context: BrainSourceReadContext<BrainMatrixNotesSourceConfig>, reader: BrainMatrixNotesReader) {
  // At most notesPerPass ids, dropped with the page.
  const ids = new Set<string>();
  let after = "";
  for (let read = 0; read < BRAIN_MATRIX_LIMITS.notesPerPass;) {
    const limit = Math.min(1_000, BRAIN_MATRIX_LIMITS.notesPerPass - read);
    const keys: readonly BrainMatrixNoteKey[] = await readThrough("notes keys", () => reader.listNoteKeys(after, limit));
    for (const key of keys) {
      if (selected(context.config, key.tags)) ids.add(matrixDocumentId(KIND, context.externalRef, [key.id]));
    }
    read += keys.length;
    if (keys.length < limit) break;
    after = keys[keys.length - 1]!.id;
  }
  return ids;
}

export function createMatrixNotesAdapter(reader: BrainMatrixNotesReader): BrainSourceAdapter<BrainMatrixNotesSourceConfig> {
  return {
    kind: KIND,
    readPage: (context) => guardRead(async () => {
      const { maxUpserts, maxRefs } = context.limits;
      if (maxUpserts < 1 || maxRefs < NOTE_REFS_MAX) return { ok: false, code: "invalid_options" };
      const cursor = context.cursor === null ? START : decodeMatrixCursor(CURSOR_PREFIX, CursorSchema, context.cursor);
      if (cursor === null) return { ok: false, code: "cursor_invalid" };
      if (cursor.phase === "scan") return scan(context, reader, cursor);
      const draft = new MatrixPageDraft(context);
      const ids = await selectedIds(context, reader);
      const after = await sweepStep(context, draft, cursor.after, async ({ documentId }) => ids.has(documentId));
      const next: NotesCursor = after === null ? START : { v: 1, phase: "sweep", after };
      return draft.page(encodeMatrixCursor(CURSOR_PREFIX, next), after === null);
    }),
  };
}

interface RawAppDb { raw(query: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

const UNDEFINED_TABLE_CODES: ReadonlySet<unknown> = new Set(["42P01", "3F000"]);
function isMissingTable(error: unknown): boolean {
  return error instanceof Error && "code" in error && UNDEFINED_TABLE_CODES.has(error.code);
}

const TAGS_READ_MAX_CHARS = 2_000;
/** Tags as read; when the column was longer than TAGS_READ_MAX_CHARS its last tag may be cut, so it is dropped. */
function readTags(row: Record<string, unknown>): string | null {
  if (typeof row.tags !== "string") return null;
  if (row.tags_cut !== true) return row.tags;
  let end = row.tags.length;
  while (end > 0 && !/[,\s]/.test(row.tags[end - 1]!)) end -= 1;
  return row.tags.slice(0, end);
}

/** The notes reader over the owner app database (AppDb.raw): fixed SQL, bound parameters, bounded columns. */
export function createBrainMatrixNotesReader(appDb: RawAppDb): BrainMatrixNotesReader {
  async function query(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    try {
      return (await appDb.raw(text, params)).rows;
    } catch (error: unknown) {
      if (isMissingTable(error)) return [];
      throw error;
    }
  }
  const max = BRAIN_MATRIX_LIMITS.noteContentReadMaxChars;
  const tags = `left(tags, ${TAGS_READ_MAX_CHARS}) AS tags, char_length(tags) > ${TAGS_READ_MAX_CHARS} AS tags_cut`;
  return {
    async listNotes(after, limit) {
      const rows = await query(`SELECT id::text AS id, left(title, 1000) AS title, left(content, ${max}) AS content,
        char_length(content) > ${max} AS content_cut, ${tags},
        COALESCE(updated_at, created_at) AS updated_at
        FROM "notes"."notes" WHERE id::text > $1 ORDER BY id::text LIMIT $2`, [after, limit]);
      return rows.flatMap((row) => {
        const id = String(row.id);
        if (!NOTE_ID.test(id)) return [];
        return [{
          id, title: typeof row.title === "string" ? row.title : null,
          content: typeof row.content === "string" ? row.content : null, contentCut: row.content_cut === true,
          tags: readTags(row),
          updatedAt: isoInstant(row.updated_at) ?? "1970-01-01T00:00:00.000Z",
        }];
      });
    },
    async listNoteKeys(after, limit) {
      const rows = await query(
        `SELECT id::text AS id, ${tags} FROM "notes"."notes" WHERE id::text > $1 ORDER BY id::text LIMIT $2`,
        [after, limit],
      );
      return rows.flatMap((row) => {
        const id = String(row.id);
        return NOTE_ID.test(id) ? [{ id, tags: readTags(row) }] : [];
      });
    },
  };
}

export function createBrainMatrixNotesHandler(
  deps: BrainMatrixNotesHandlerDeps,
): BrainSourceKindHandler<BrainMatrixNotesSourceConfig> {
  const now = deps.now ?? (() => new Date());
  return {
    kind: KIND,
    parseConfig: parseNotesConfig,
    identify: (_project, config) => identifyNotes(config),
    saveConfig: (scope, sourceId, config) => saveMatrixConfig(deps.kysely, KIND, scope, sourceId, config, now()),
    async loadConfig(scope, sourceId) {
      const raw = await loadMatrixConfig(deps.kysely, KIND, scope, sourceId);
      return raw === null ? null : parseNotesConfig(raw);
    },
    async createAdapter() {
      if (deps.notes === null) return { ok: false, code: "not_connected" };
      return { ok: true, adapter: createMatrixNotesAdapter(deps.notes) };
    },
    viewConfig: (config) => ({ folders: [...config.folders] }),
    async availability() {
      return deps.notes === null ? { available: false, reason: "not_configured" } : { available: true };
    },
  };
}
