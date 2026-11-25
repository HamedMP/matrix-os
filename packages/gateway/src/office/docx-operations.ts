import { describeDocx, parseAgentEdits, toDocxOps } from "@matrix-os/office";
import type { AgentDocxEdit, DocxBlock, DocxDocument, DocxTextView, RejectedEdit, TextRange } from "@matrix-os/office";
import {
  OFFICE_MAX_LISTED_REVISIONS,
  type OfficeDocxEdit, type OfficeRevision,
} from "@matrix-os/contracts/office-documents";
import { OfficeDocumentError } from "./document-error.js";

/** Pure operations on an opened document. No file I/O; the service loads and saves. */

const MAX_OUTLINE_ITEMS = 500;
const MAX_REVISION_TEXT = 2_000;
const MAX_REVISION_BLOCK_IDS = 50;

export interface DocxEditOutcome {
  changed: boolean;
  revisionIds: string[];
  commentIds: string[];
  appliedEdits: number[];
  rejected: Array<{ index: number; code: RejectedEdit["code"] }>;
}

/** Validates edits with the engine's own envelope parser, which also enforces its bounds. */
function engineDocxEdits(edits: readonly OfficeDocxEdit[]): AgentDocxEdit[] {
  const parsed = parseAgentEdits(JSON.stringify({ kind: "docx", edits }), "docx");
  if (!parsed.ok) throw new OfficeDocumentError("invalid_request", `agent edits: ${parsed.error.code} at ${parsed.error.path ?? "-"}`);
  if (parsed.envelope.kind !== "docx") throw new OfficeDocumentError("invalid_request", "agent edits: wrong kind");
  return parsed.envelope.edits;
}

export function describeDocument(document: DocxDocument, options: { maxChars: number; startBlockId?: string; storyId?: string }) {
  const description = describeDocx(document, {
    maxChars: options.maxChars,
    ...(options.startBlockId ? { startBlockId: options.startBlockId } : {}),
    ...(options.storyId ? { storyId: options.storyId } : {}),
  });
  return {
    text: description.text,
    truncated: description.truncated,
    nextBlockId: description.nextBlockId,
    blockIds: description.blockIds,
    outline: document.getOutline().slice(0, MAX_OUTLINE_ITEMS).map((item) => ({
      blockId: item.blockId, level: item.level, text: item.text, numberingLabel: item.numberingLabel,
    })),
    revisionCount: document.listRevisions().length,
    commentCount: document.listComments().length,
  };
}

function paragraphText(document: DocxDocument, blockId: string, length: number, view: DocxTextView): string {
  const range: TextRange = { start: { blockId, offset: 0 }, end: { blockId, offset: length } };
  return document.getPlainText({ range, view });
}

function blockText(document: DocxDocument, block: DocxBlock, view: DocxTextView): string {
  if (block.type === "paragraph") return paragraphText(document, block.id, block.text.length, view);
  if (block.type === "table") {
    return block.rows
      .map((row) => row.cells.map((cell) => cell.blocks.map((inner) => blockText(document, inner, view)).join(" ")).join("\t"))
      .join("\n");
  }
  return "";
}

export function readDocumentText(
  document: DocxDocument,
  request: { blockIds?: string[]; range?: TextRange; view: DocxTextView; maxChars: number },
) {
  let budget = request.maxChars;
  let truncated = false;
  const take = (text: string): string => {
    if (text.length <= budget) { budget -= text.length; return text; }
    truncated = true;
    const cut = text.slice(0, budget);
    budget = 0;
    return cut;
  };
  if (request.range) {
    return { blocks: [], missingBlockIds: [], text: take(document.getPlainText({ range: request.range, view: request.view })), truncated };
  }
  const blocks: Array<{ blockId: string; type: DocxBlock["type"]; text: string }> = [];
  const missingBlockIds: string[] = [];
  for (const blockId of request.blockIds ?? []) {
    const block = document.getBlock(blockId);
    if (!block) { missingBlockIds.push(blockId); continue; }
    if (truncated) continue;
    blocks.push({ blockId, type: block.type, text: take(blockText(document, block, request.view)) });
  }
  return { blocks, missingBlockIds, text: blocks.map((block) => block.text).join("\n"), truncated };
}

/** Applies agent edits as tracked revisions. Edits that do not resolve are reported, never applied. */
export function applyDocumentEdits(document: DocxDocument, edits: readonly OfficeDocxEdit[], author: string, date: string): DocxEditOutcome {
  const plan = toDocxOps(document, engineDocxEdits(edits));
  const rejected = plan.rejected.map(({ index, code }) => ({ index, code }));
  if (plan.ops.length === 0) return { changed: false, revisionIds: [], commentIds: [], appliedEdits: [], rejected };
  const result = document.applyOps(plan.ops, { track: true, author, date });
  const commentIds = result.results.flatMap((entry) => (entry.commentId ? [entry.commentId] : []));
  const appliedEdits = [...new Set(plan.opEditIndexes)].sort((a, b) => a - b);
  return { changed: true, revisionIds: result.revisionIds, commentIds, appliedEdits, rejected };
}

/** Adds one comment; quoted text that does not resolve is an error rather than a partial result. */
export function addDocumentComment(
  document: DocxDocument,
  request: { blockId: string; find: string; occurrence?: number; text: string },
  author: string,
  date: string,
): string {
  const edit: OfficeDocxEdit = {
    op: "comment", blockId: request.blockId, find: request.find, text: request.text,
    ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
  };
  const outcome = applyDocumentEdits(document, [edit], author, date);
  const refused = outcome.rejected[0];
  if (refused) {
    const code = refused.code === "invalid_operation" ? "invalid_operation" : refused.code === "ambiguous" ? "invalid_request" : "stale_reference";
    throw new OfficeDocumentError(code, `comment ${refused.code}`);
  }
  const commentId = outcome.commentIds[0];
  if (!commentId) throw new OfficeDocumentError("internal", "comment not created");
  return commentId;
}

export function listDocumentRevisions(document: DocxDocument): { revisions: OfficeRevision[]; total: number; truncated: boolean } {
  const all = document.listRevisions();
  const revisions = all.slice(0, OFFICE_MAX_LISTED_REVISIONS).map((revision) => ({
    id: revision.id,
    kind: revision.kind,
    scope: revision.scope,
    author: revision.author,
    date: revision.date,
    storyId: revision.storyId,
    blockIds: revision.blockIds.slice(0, MAX_REVISION_BLOCK_IDS),
    text: revision.text.slice(0, MAX_REVISION_TEXT),
    textTruncated: revision.text.length > MAX_REVISION_TEXT,
    pairedWith: revision.pairedWith,
  }));
  return { revisions, total: all.length, truncated: all.length > revisions.length };
}

export function resolveDocumentRevisions(document: DocxDocument, ids: readonly string[] | "all", accept: boolean): string[] {
  const result = accept ? document.acceptRevisions(ids) : document.rejectRevisions(ids);
  return result.resolvedIds;
}
