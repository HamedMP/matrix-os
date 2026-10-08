import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import { BoundedActionJsonSchema, type CanonicalOwnerScope } from "@matrix-os/contracts";
import type { AppDb } from "../app-db.js";
import { CanonicalActionError } from "./action-repository.js";
import type { ActionToolInput, CanonicalActionTool } from "./action-tools.js";

const noteSchema = z.object({
  app: z.literal("notes"),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(16_000),
}).strict();
const listNotesSchema = z.object({
  app: z.literal("notes"),
  id: z.uuid().optional(),
}).strict();
const editNoteSchema = noteSchema.extend({
  id: z.uuid(),
  expectedUpdatedAt: z.string().min(20).max(40).regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/),
}).strict();

type NoteArguments = z.infer<typeof noteSchema>;
type NoteRow = {
  id: string;
  title: string;
  content: string;
  content_json: unknown;
  pinned: boolean;
  tags: string;
  updated_at?: string;
};

const navigation = Object.freeze({ kind: "open_app", app: "notes", path: "apps/notes" });

function deterministicNoteId(owner: CanonicalOwnerScope, actionId: string): string {
  const bytes = createHash("sha256")
    .update("matrix-create-note:v1\0")
    .update(owner.type)
    .update("\0")
    .update(owner.ownerId)
    .update("\0")
    .update(actionId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function tiptapDocument(content: string) {
  return {
    type: "doc",
    content: content.split("\n").map((line) => line.length === 0
      ? { type: "paragraph" }
      : { type: "paragraph", content: [{ type: "text", text: line }] }),
  };
}

function expectedRow(input: ActionToolInput, args: NoteArguments): NoteRow {
  return {
    id: deterministicNoteId(input.owner, input.actionId),
    title: args.title,
    content: args.content,
    content_json: tiptapDocument(args.content),
    pinned: false,
    tags: "",
  };
}

function rowsMatch(actual: Record<string, unknown> | undefined, expected: NoteRow): boolean {
  return actual?.id === expected.id
    && actual.title === expected.title
    && actual.content === expected.content
    && isDeepStrictEqual(actual.content_json, expected.content_json)
    && actual.pinned === expected.pinned
    && actual.tags === expected.tags;
}

function result(row: NoteRow) {
  return { app: "notes", note: { id: row.id, title: row.title }, navigation };
}

async function requireInstalledNotes(db: AppDb): Promise<void> {
  const registered = await db.raw("SELECT tables FROM public._apps WHERE slug = $1", ["notes"]);
  const tables = registered.rows[0]?.tables as Record<string, unknown> | undefined;
  if (!tables || typeof tables.notes !== "object" || tables.notes === null) throw new CanonicalActionError();
}

export function createNoteActionTool(options: {
  db: AppDb;
  homeForOwner: (owner: CanonicalOwnerScope) => Promise<string>;
  notify: (ownerId: string) => void;
}): CanonicalActionTool {
  const normalize = (input: unknown): NoteArguments => {
    BoundedActionJsonSchema.parse(input);
    const normalized = noteSchema.parse(input);
    BoundedActionJsonSchema.parse(normalized);
    return normalized;
  };

  return {
    toolId: "matrix_create_note",
    schemaRevision: "create_note_v1",
    description: "Create one plain-text note in the owner's installed Notes app and open Notes.",
    inputSchema: z.toJSONSchema(noteSchema),
    effect: "data",
    approval: false,
    reconciliation: true,
    cancellation: "before_dispatch",
    normalize,
    async execute(input) {
      await options.homeForOwner(input.owner);
      input.signal.throwIfAborted();
      const args = noteSchema.parse(input.arguments);
      await requireInstalledNotes(options.db);
      input.signal.throwIfAborted();
      const expected = expectedRow(input, args);
      const inserted = await options.db.raw(
        `INSERT INTO notes.notes (id, title, content, content_json, pinned, tags)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [expected.id, expected.title, expected.content, JSON.stringify(expected.content_json), expected.pinned, expected.tags],
      );
      const stored = await options.db.raw(
        "SELECT id::text, title, content, content_json, pinned, tags FROM notes.notes WHERE id = $1",
        [expected.id],
      );
      if (!rowsMatch(stored.rows[0], expected)) throw new CanonicalActionError();
      if (inserted.rows.length === 1) options.notify(input.owner.ownerId);
      return result(expected);
    },
    async reconcile(input) {
      await options.homeForOwner(input.owner);
      input.signal.throwIfAborted();
      const args = noteSchema.parse(input.arguments);
      await requireInstalledNotes(options.db);
      const expected = expectedRow(input, args);
      const stored = await options.db.raw(
        "SELECT id::text, title, content, content_json, pinned, tags FROM notes.notes WHERE id = $1",
        [expected.id],
      );
      return rowsMatch(stored.rows[0], expected)
        ? { confirmed: true, result: result(expected) }
        : { confirmed: false };
    },
  };
}

export function createNoteActionTools(options: {
  db: AppDb;
  homeForOwner: (owner: CanonicalOwnerScope) => Promise<string>;
  notify: (ownerId: string) => void;
}): readonly CanonicalActionTool[] {
  const create = createNoteActionTool(options);
  const normalize = <T>(schema: z.ZodType<T>) => (input: unknown): T => {
    BoundedActionJsonSchema.parse(input);
    const normalized = schema.parse(input);
    BoundedActionJsonSchema.parse(normalized);
    return normalized;
  };
  const list: CanonicalActionTool = {
    toolId: "matrix_list_notes",
    schemaRevision: "list_notes_v2",
    description: "List up to 16 note previews, or pass one exact note ID to read its complete editable content and current concurrency timestamp before replacement. Preview content is explicitly truncated and cannot be used for editing.",
    inputSchema: z.toJSONSchema(listNotesSchema),
    effect: "read",
    approval: false,
    reconciliation: false,
    cancellation: "before_dispatch",
    normalize: normalize(listNotesSchema),
    async execute(input) {
      await options.homeForOwner(input.owner);
      input.signal.throwIfAborted();
      const args = listNotesSchema.parse(input.arguments);
      await requireInstalledNotes(options.db);
      const fullRead = args.id !== undefined;
      const rows = fullRead
        ? await options.db.raw(
          `SELECT id::text, title, LEFT(content, 16000) AS content,
                  char_length(content) > 16000 AS content_truncated, updated_at::text
           FROM notes.notes WHERE id = $1 LIMIT 1`,
          [args.id],
        )
        : await options.db.raw(
          `SELECT id::text, title, LEFT(content, 2000) AS content,
                  char_length(content) > 2000 AS content_truncated, updated_at::text
           FROM notes.notes ORDER BY updated_at DESC, id LIMIT 16`,
        );
      return { app: "notes", notes: rows.rows.map(row => ({
        id: row.id,
        title: row.title,
        content: row.content,
        contentTruncated: Boolean(row.content_truncated),
        editable: fullRead && !row.content_truncated,
        ...(!fullRead
          ? { uneditableReason: "full_read_required" }
          : row.content_truncated
            ? { uneditableReason: "content_exceeds_16000_character_edit_limit" }
            : {}),
        updatedAt: row.updated_at,
      })) };
    },
  };
  const editResult = (row: NoteRow) => ({
    app: "notes", note: { id: row.id, title: row.title, updatedAt: row.updated_at }, navigation,
  });
  const edit: CanonicalActionTool = {
    toolId: "matrix_edit_note",
    schemaRevision: "edit_note_v1",
    description: "Replace one exact existing Notes record using its listed ID and expectedUpdatedAt concurrency token, then open Notes.",
    inputSchema: z.toJSONSchema(editNoteSchema),
    effect: "data",
    approval: false,
    reconciliation: true,
    cancellation: "before_dispatch",
    normalize: normalize(editNoteSchema),
    async execute(input) {
      await options.homeForOwner(input.owner);
      input.signal.throwIfAborted();
      const args = editNoteSchema.parse(input.arguments);
      await requireInstalledNotes(options.db);
      const contentJson = tiptapDocument(args.content);
      const updated = await options.db.raw(
        `UPDATE notes.notes
         SET title = $1, content = $2, content_json = $3::jsonb, updated_at = clock_timestamp()
         WHERE id = $4 AND updated_at = $5::timestamptz
         RETURNING id::text, title, content, content_json, pinned, tags, updated_at::text`,
        [args.title, args.content, JSON.stringify(contentJson), args.id, args.expectedUpdatedAt],
      );
      let row = updated.rows[0] as NoteRow | undefined;
      if (!row) {
        const stored = await options.db.raw(
          "SELECT id::text, title, content, content_json, pinned, tags, updated_at::text FROM notes.notes WHERE id = $1",
          [args.id],
        );
        row = stored.rows[0] as NoteRow | undefined;
        if (!row || row.title !== args.title || row.content !== args.content || !isDeepStrictEqual(row.content_json, contentJson)) {
          throw new CanonicalActionError();
        }
      } else {
        options.notify(input.owner.ownerId);
      }
      return editResult(row);
    },
    async reconcile(input) {
      await options.homeForOwner(input.owner);
      input.signal.throwIfAborted();
      const args = editNoteSchema.parse(input.arguments);
      await requireInstalledNotes(options.db);
      const stored = await options.db.raw(
        "SELECT id::text, title, content, content_json, pinned, tags, updated_at::text FROM notes.notes WHERE id = $1",
        [args.id],
      );
      const row = stored.rows[0] as NoteRow | undefined;
      return row && row.title === args.title && row.content === args.content
        && isDeepStrictEqual(row.content_json, tiptapDocument(args.content))
        ? { confirmed: true, result: editResult(row) }
        : { confirmed: false };
    },
  };
  return Object.freeze([create, list, edit]);
}
