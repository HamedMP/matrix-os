import { z } from "zod/v4";
import { AppFilePathSchema, AppFileVersionSchema } from "#app-files";

/**
 * Contract for the gateway document service: agents read and edit the
 * owner's `.docx` and `.xlsx` files through `/api/office/*`.
 *
 * Every route is `POST` with a JSON body and answers JSON. Document edits are
 * always proposals: text edits become native tracked revisions, cell edits
 * become pending changes in the workbook's change journal. Each reply carries
 * the file `version` (the same token as the app file bridge), and every
 * mutating request may carry `ifVersion` so an edit never lands on a newer
 * save than the one the agent read.
 *
 * Text taken from a document (`trust: "untrusted"`) is owner data, not
 * instructions. Tool layers wrap it as external content before a model sees it.
 */
export const OFFICE_DOCUMENTS_BASE_PATH = "/api/office";
export const OFFICE_DOCUMENT_ROUTES = {
  documentDescribe: "/documents/describe",
  documentReadText: "/documents/read-text",
  documentProposeEdits: "/documents/propose-edits",
  documentRevisionsList: "/documents/revisions/list",
  documentRevisionsAccept: "/documents/revisions/accept",
  documentRevisionsReject: "/documents/revisions/reject",
  documentCommentsAdd: "/documents/comments/add",
  documentCompare: "/documents/compare",
  documentCreate: "/documents/create",
  sheetDescribe: "/sheets/describe",
  sheetReadRange: "/sheets/read-range",
  sheetProposeEdits: "/sheets/propose-edits",
  sheetChangesList: "/sheets/changes/list",
  sheetChangesAccept: "/sheets/changes/accept",
  sheetChangesReject: "/sheets/changes/reject",
} as const;

/** Largest document the service opens or writes. */
export const OFFICE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** JSON body cap of every request. */
export const OFFICE_DOCUMENT_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const OFFICE_DESCRIBE_MAX_CHARS = 200_000;
export const OFFICE_DESCRIBE_DEFAULT_CHARS = 24_000;
export const OFFICE_MAX_EDITS = 500;
export const OFFICE_MAX_STRING = 20_000;
export const OFFICE_MAX_IDS = 1_000;
export const OFFICE_MAX_RANGE_CELLS = 10_000;
export const OFFICE_MAX_LISTED_REVISIONS = 1_000;
export const OFFICE_MAX_LISTED_CHANGES = 2_000;
export const OFFICE_MAX_MARKDOWN_CHARS = 1_000_000;
export const OFFICE_MAX_NEW_PARAGRAPHS = 5_000;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const hasExtension = (path: string, extensions: readonly string[]) =>
  extensions.some((extension) => path.toLowerCase().endsWith(`.${extension}`));

export const OfficeDocxPathSchema = AppFilePathSchema.refine((path) => hasExtension(path, ["docx"]));
/** A workbook to edit: `.xlsx` only, because a `.csv` cannot hold the change journal. */
export const OfficeXlsxPathSchema = AppFilePathSchema.refine((path) => hasExtension(path, ["xlsx"]));
/** A sheet to read: `.xlsx` or `.csv`. */
export const OfficeSheetPathSchema = AppFilePathSchema.refine((path) => hasExtension(path, ["xlsx", "csv"]));
export const OfficeVersionSchema = AppFileVersionSchema;
/** Block, story, revision and change ids are opaque engine tokens. */
export const OfficeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:._-]+$/);
export const OfficeAuthorSchema = z.string().trim().min(1).max(100).refine((value) => !CONTROL.test(value) && !value.includes("\n"));
const DocumentText = z.string().max(OFFICE_MAX_STRING).refine((value) => !CONTROL.test(value));
const NonEmptyDocumentText = DocumentText.refine((value) => value.length > 0);
const A1Cell = z.string().min(2).max(12).regex(/^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/);
/** The forms the engine's `parseA1Range` reads: a cell, two cells, whole columns (`A:C`) or whole rows (`2:5`). */
export const OfficeA1RangeSchema = z.string().min(1).max(32).regex(
  /^(?:\$?[A-Za-z]{1,3}\$?[0-9]{1,7}(?::\$?[A-Za-z]{1,3}\$?[0-9]{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?[0-9]{1,7}:\$?[0-9]{1,7})$/,
);
const SheetName = z.string().min(1).max(31).refine((value) => !/[:\\/?*[\]]/.test(value) && !CONTROL.test(value));
const IdsOrAll = z.union([z.literal("all"), z.array(OfficeIdSchema).min(1).max(OFFICE_MAX_IDS)]);
const Occurrence = z.number().int().min(1).max(10_000);

/** The agent edit envelope for a `.docx`, as `parseAgentEdits` of the engine reads it. */
export const OfficeDocxEditSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("replaceText"), blockId: OfficeIdSchema, find: NonEmptyDocumentText, replace: DocumentText, occurrence: Occurrence.optional() }),
  z.strictObject({
    op: z.literal("insertParagraph"), blockId: OfficeIdSchema, position: z.enum(["after", "before"]).optional(),
    text: DocumentText, headingLevel: z.number().int().min(1).max(9).optional(),
  }),
  z.strictObject({ op: z.literal("deleteParagraph"), blockId: OfficeIdSchema, startsWith: DocumentText }),
  z.strictObject({ op: z.literal("comment"), blockId: OfficeIdSchema, find: DocumentText, occurrence: Occurrence.optional(), text: NonEmptyDocumentText }),
]);
export type OfficeDocxEdit = z.infer<typeof OfficeDocxEditSchema>;

const CellInput = z.union([z.string().max(OFFICE_MAX_STRING), z.number().finite(), z.boolean(), z.null()]);
export const OfficeSheetEditSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("setCell"), sheet: SheetName, cell: A1Cell, value: CellInput, expect: z.string().max(OFFICE_MAX_STRING).optional() }),
  z.strictObject({
    op: z.literal("setRange"), sheet: SheetName, start: A1Cell,
    values: z.array(z.array(CellInput).max(OFFICE_MAX_RANGE_CELLS)).min(1).max(OFFICE_MAX_RANGE_CELLS)
      .refine((rows) => rows.reduce((sum, row) => sum + row.length, 0) <= OFFICE_MAX_RANGE_CELLS),
  }),
  z.strictObject({ op: z.literal("clearRange"), sheet: SheetName, range: OfficeA1RangeSchema }),
]);
export type OfficeSheetEdit = z.infer<typeof OfficeSheetEditSchema>;

const TextPosition = z.strictObject({ blockId: OfficeIdSchema, offset: z.number().int().min(0).max(10_000_000) });

// ---- Requests ----

export const DocumentDescribeRequestSchema = z.strictObject({
  path: OfficeDocxPathSchema,
  maxChars: z.number().int().min(1).max(OFFICE_DESCRIBE_MAX_CHARS).default(OFFICE_DESCRIBE_DEFAULT_CHARS),
  startBlockId: OfficeIdSchema.optional(),
  storyId: OfficeIdSchema.optional(),
});
export const DocumentReadTextRequestSchema = z.strictObject({
  path: OfficeDocxPathSchema,
  blockIds: z.array(OfficeIdSchema).min(1).max(200).optional(),
  range: z.strictObject({ start: TextPosition, end: TextPosition }).optional(),
  view: z.enum(["final", "original", "markup"]).default("final"),
  maxChars: z.number().int().min(1).max(OFFICE_DESCRIBE_MAX_CHARS).default(OFFICE_DESCRIBE_DEFAULT_CHARS),
}).refine((value) => (value.blockIds === undefined) !== (value.range === undefined), { message: "Give blockIds or range" });
export const DocumentProposeEditsRequestSchema = z.strictObject({
  path: OfficeDocxPathSchema,
  edits: z.array(OfficeDocxEditSchema).min(1).max(OFFICE_MAX_EDITS),
  author: OfficeAuthorSchema,
  summary: z.string().max(2_000).optional(),
  ifVersion: OfficeVersionSchema.optional(),
});
export const DocumentPathRequestSchema = z.strictObject({ path: OfficeDocxPathSchema });
/**
 * Revision ids are numbered again each time the file opens, so a list of ids
 * only names the revisions of the version it was listed at: `ifVersion` is
 * required with ids, and a newer file answers `version_conflict`.
 */
export const DocumentResolveRevisionsRequestSchema = z.strictObject({
  path: OfficeDocxPathSchema,
  ids: IdsOrAll,
  ifVersion: OfficeVersionSchema.optional(),
}).refine((value) => value.ids === "all" || value.ifVersion !== undefined, { message: "Give ifVersion with revision ids" });
export const DocumentAddCommentRequestSchema = z.strictObject({
  path: OfficeDocxPathSchema,
  blockId: OfficeIdSchema,
  /** Exact text to anchor to; empty anchors the whole paragraph. */
  find: DocumentText.default(""),
  occurrence: Occurrence.optional(),
  text: NonEmptyDocumentText,
  author: OfficeAuthorSchema,
  ifVersion: OfficeVersionSchema.optional(),
});
export const DocumentCompareRequestSchema = z.strictObject({
  originalPath: OfficeDocxPathSchema,
  revisedPath: OfficeDocxPathSchema,
  /** Must not exist yet. */
  outputPath: OfficeDocxPathSchema,
  author: OfficeAuthorSchema.default("Matrix OS"),
});
export const DocumentCreateRequestSchema = z.strictObject({
  /** Must not exist yet. */
  path: OfficeDocxPathSchema,
  markdown: z.string().max(OFFICE_MAX_MARKDOWN_CHARS).optional(),
  paragraphs: z.array(DocumentText).max(OFFICE_MAX_NEW_PARAGRAPHS).optional(),
  title: z.string().max(500).refine((value) => !CONTROL.test(value)).optional(),
  author: OfficeAuthorSchema.optional(),
}).refine((value) => (value.markdown === undefined) !== (value.paragraphs === undefined), { message: "Give markdown or paragraphs" });

export const SheetDescribeRequestSchema = z.strictObject({
  path: OfficeSheetPathSchema,
  sheet: SheetName.optional(),
  range: OfficeA1RangeSchema.optional(),
  maxChars: z.number().int().min(1).max(OFFICE_DESCRIBE_MAX_CHARS).default(OFFICE_DESCRIBE_DEFAULT_CHARS),
});
export const SheetReadRangeRequestSchema = z.strictObject({
  path: OfficeSheetPathSchema,
  sheet: SheetName.optional(),
  range: OfficeA1RangeSchema,
});
export const SheetProposeEditsRequestSchema = z.strictObject({
  path: OfficeXlsxPathSchema,
  edits: z.array(OfficeSheetEditSchema).min(1).max(OFFICE_MAX_EDITS),
  author: OfficeAuthorSchema,
  label: z.string().trim().min(1).max(200).refine((value) => !CONTROL.test(value)),
  ifVersion: OfficeVersionSchema.optional(),
});
export const SheetPathRequestSchema = z.strictObject({ path: OfficeXlsxPathSchema });
export const SheetResolveChangesRequestSchema = z.strictObject({
  path: OfficeXlsxPathSchema,
  ids: IdsOrAll,
  ifVersion: OfficeVersionSchema.optional(),
});

export type DocumentDescribeRequest = z.input<typeof DocumentDescribeRequestSchema>;
export type DocumentReadTextRequest = z.input<typeof DocumentReadTextRequestSchema>;
export type DocumentProposeEditsRequest = z.input<typeof DocumentProposeEditsRequestSchema>;
export type DocumentPathRequest = z.input<typeof DocumentPathRequestSchema>;
export type DocumentResolveRevisionsRequest = z.input<typeof DocumentResolveRevisionsRequestSchema>;
export type DocumentAddCommentRequest = z.input<typeof DocumentAddCommentRequestSchema>;
export type DocumentCompareRequest = z.input<typeof DocumentCompareRequestSchema>;
export type DocumentCreateRequest = z.input<typeof DocumentCreateRequestSchema>;
export type SheetDescribeRequest = z.input<typeof SheetDescribeRequestSchema>;
export type SheetReadRangeRequest = z.input<typeof SheetReadRangeRequestSchema>;
export type SheetProposeEditsRequest = z.input<typeof SheetProposeEditsRequestSchema>;
export type SheetPathRequest = z.input<typeof SheetPathRequestSchema>;
export type SheetResolveChangesRequest = z.input<typeof SheetResolveChangesRequestSchema>;

// ---- Replies ----

const Trust = z.literal("untrusted");
const Path = AppFilePathSchema;
const Version = OfficeVersionSchema;
const Ids = z.array(z.string().max(128)).max(100_000);
const RejectedEditSchema = z.strictObject({
  index: z.number().int().min(0),
  code: z.enum(["not_found", "stale_reference", "ambiguous", "invalid_operation", "invalid_edit"]),
});
/** A JSON-safe cell value: a formula error is `{ error: "#DIV/0!" }`. */
export const OfficeCellValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null(), z.strictObject({ error: z.string().max(16) })]);
export type OfficeCellValue = z.infer<typeof OfficeCellValueSchema>;

export const DocumentDescribeReplySchema = z.strictObject({
  path: Path, version: Version, trust: Trust,
  text: z.string(), truncated: z.boolean(), nextBlockId: z.string().nullable(), blockIds: Ids,
  outline: z.array(z.strictObject({ blockId: z.string(), level: z.number().int(), text: z.string(), numberingLabel: z.string().nullable() })).max(500),
  revisionCount: z.number().int().min(0), commentCount: z.number().int().min(0),
});
export const DocumentReadTextReplySchema = z.strictObject({
  path: Path, version: Version, trust: Trust,
  blocks: z.array(z.strictObject({ blockId: z.string(), type: z.enum(["paragraph", "table", "sectionBreak"]), text: z.string() })).max(200),
  missingBlockIds: Ids,
  text: z.string(), truncated: z.boolean(),
});
export const DocumentProposeEditsReplySchema = z.strictObject({
  path: Path, version: Version, saved: z.boolean(),
  revisionIds: Ids, commentIds: Ids, appliedEdits: z.array(z.number().int().min(0)), rejected: z.array(RejectedEditSchema),
});
export const OfficeRevisionSchema = z.strictObject({
  id: z.string(), kind: z.enum(["insert", "delete", "moveFrom", "moveTo", "format"]),
  scope: z.enum(["text", "runFormat", "paragraphFormat", "tableRow"]),
  author: z.string(), date: z.string().nullable(), storyId: z.string(), blockIds: Ids,
  text: z.string(), textTruncated: z.boolean(), pairedWith: z.string().nullable(),
});
export const DocumentRevisionsListReplySchema = z.strictObject({
  path: Path, version: Version, trust: Trust, revisions: z.array(OfficeRevisionSchema).max(OFFICE_MAX_LISTED_REVISIONS),
  total: z.number().int().min(0), truncated: z.boolean(),
});
export const DocumentResolveRevisionsReplySchema = z.strictObject({ path: Path, version: Version, saved: z.boolean(), resolvedIds: Ids });
export const DocumentAddCommentReplySchema = z.strictObject({ path: Path, version: Version, commentId: z.string() });
export const DocumentCompareReplySchema = z.strictObject({
  outputPath: Path, version: Version, identical: z.boolean(), revisionCount: z.number().int().min(0),
  substantive: z.number().int().min(0), formattingOnly: z.number().int().min(0),
});
export const DocumentCreateReplySchema = z.strictObject({ path: Path, version: Version, size: z.number().int().min(0) });

export const OfficeSheetInfoSchema = z.strictObject({
  id: z.string(), name: z.string(), index: z.number().int().min(0), state: z.enum(["visible", "hidden", "veryHidden"]),
  usedRange: z.string().nullable(), pendingChangeCount: z.number().int().min(0),
});
export const SheetDescribeReplySchema = z.strictObject({
  path: Path, version: Version, trust: Trust, sheets: z.array(OfficeSheetInfoSchema),
  sheet: z.string(), range: z.string(), text: z.string(), truncated: z.boolean(),
});
export const OfficeCellSchema = z.strictObject({
  value: OfficeCellValueSchema, formula: z.string().nullable(), display: z.string(), pendingChangeId: z.string().nullable(),
});
export const SheetReadRangeReplySchema = z.strictObject({
  path: Path, version: Version, trust: Trust, sheet: z.string(), range: z.string(), cells: z.array(z.array(OfficeCellSchema)),
});
export const SheetProposeEditsReplySchema = z.strictObject({
  path: Path, version: Version, saved: z.boolean(), proposalId: z.string().nullable(), changeIds: Ids,
  appliedEdits: z.array(z.number().int().min(0)), rejected: z.array(RejectedEditSchema),
});
export const OfficeCellChangeSchema = z.strictObject({
  id: z.string(), proposalId: z.string(), sheet: z.string(), cell: z.string(), author: z.string(), date: z.string(), label: z.string(),
  oldValue: OfficeCellValueSchema, newValue: OfficeCellValueSchema, oldFormula: z.string().nullable(), newFormula: z.string().nullable(),
});
export const SheetChangesListReplySchema = z.strictObject({
  path: Path, version: Version, trust: Trust, changes: z.array(OfficeCellChangeSchema).max(OFFICE_MAX_LISTED_CHANGES),
  proposals: z.array(z.strictObject({ id: z.string(), author: z.string(), date: z.string(), label: z.string(), pendingCount: z.number().int().min(0) })),
  total: z.number().int().min(0), truncated: z.boolean(),
});
export const SheetResolveChangesReplySchema = z.strictObject({ path: Path, version: Version, saved: z.boolean(), resolvedIds: Ids, staleIds: Ids });

export type DocumentDescribeReply = z.infer<typeof DocumentDescribeReplySchema>;
export type DocumentReadTextReply = z.infer<typeof DocumentReadTextReplySchema>;
export type DocumentProposeEditsReply = z.infer<typeof DocumentProposeEditsReplySchema>;
export type OfficeRevision = z.infer<typeof OfficeRevisionSchema>;
export type DocumentRevisionsListReply = z.infer<typeof DocumentRevisionsListReplySchema>;
export type DocumentResolveRevisionsReply = z.infer<typeof DocumentResolveRevisionsReplySchema>;
export type DocumentAddCommentReply = z.infer<typeof DocumentAddCommentReplySchema>;
export type DocumentCompareReply = z.infer<typeof DocumentCompareReplySchema>;
export type DocumentCreateReply = z.infer<typeof DocumentCreateReplySchema>;
export type OfficeSheetInfo = z.infer<typeof OfficeSheetInfoSchema>;
export type SheetDescribeReply = z.infer<typeof SheetDescribeReplySchema>;
export type OfficeCell = z.infer<typeof OfficeCellSchema>;
export type SheetReadRangeReply = z.infer<typeof SheetReadRangeReplySchema>;
export type SheetProposeEditsReply = z.infer<typeof SheetProposeEditsReplySchema>;
export type OfficeCellChange = z.infer<typeof OfficeCellChangeSchema>;
export type SheetChangesListReply = z.infer<typeof SheetChangesListReplySchema>;
export type SheetResolveChangesReply = z.infer<typeof SheetResolveChangesReplySchema>;

// ---- Errors ----

export const OFFICE_DOCUMENT_ERROR_CODES = [
  "invalid_request", "not_found", "forbidden", "too_large", "version_conflict", "file_exists",
  "unsupported_document", "stale_reference", "invalid_operation", "busy", "unavailable", "internal",
] as const;
export type OfficeDocumentErrorCode = (typeof OFFICE_DOCUMENT_ERROR_CODES)[number];
export const OFFICE_DOCUMENT_ERROR_STATUS = {
  invalid_request: 400, not_found: 404, forbidden: 403, too_large: 413, version_conflict: 409, file_exists: 409,
  unsupported_document: 422, stale_reference: 409, invalid_operation: 422, busy: 503, unavailable: 503, internal: 500,
} as const satisfies Record<OfficeDocumentErrorCode, number>;
const OFFICE_DOCUMENT_ERROR_MESSAGES: Record<OfficeDocumentErrorCode, string> = {
  invalid_request: "Invalid request",
  not_found: "File not found",
  forbidden: "Path not allowed",
  too_large: "File too large",
  version_conflict: "File changed since it was read",
  file_exists: "File already exists",
  unsupported_document: "Unsupported or damaged document",
  stale_reference: "The document no longer matches the reference",
  invalid_operation: "Operation not allowed on this document",
  busy: "Document service busy",
  unavailable: "Document service unavailable",
  internal: "Document service error",
};
export const OfficeDocumentErrorBodySchema = z.strictObject({ error: z.enum(OFFICE_DOCUMENT_ERROR_CODES), message: z.string() });
export type OfficeDocumentErrorBody = z.infer<typeof OfficeDocumentErrorBodySchema>;
export function officeDocumentErrorBody(code: OfficeDocumentErrorCode): OfficeDocumentErrorBody {
  return { error: code, message: OFFICE_DOCUMENT_ERROR_MESSAGES[code] };
}
