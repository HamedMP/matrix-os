import { compareDocxDetailed, createDocx, createDocxFromMarkdown, openDocx } from "@matrix-os/office";
import type { DocxDocument, DocxTextView, TextRange, Workbook } from "@matrix-os/office";
import type { OfficeDocxEdit, OfficeSheetEdit } from "@matrix-os/contracts/office-documents";
import {
  addDocumentComment, applyDocumentEdits, describeDocument, listDocumentRevisions, readDocumentText, resolveDocumentRevisions,
} from "./docx-operations.js";
import {
  describeWorkbookSheet, listWorkbookChanges, loadWorkbook, proposeWorkbookEdits, readWorkbookRange, resolveWorkbookChanges,
} from "./sheet-operations.js";

/**
 * Every use the document service makes of the engine, as plain data in and
 * plain data out, so one call can run on another thread. An operation gets
 * the file's bytes and returns its answer; an edit also returns the saved
 * file. Nothing here touches the file system.
 */

/** The answer of an edit, with the saved file when the edit changed it. */
export interface EngineEdit<R> {
  changed: boolean;
  result: R;
  bytes: Uint8Array | null;
}

type Ids = readonly string[] | "all";

async function edit<H extends { save(): Promise<Uint8Array> }, R>(
  handle: H,
  run: (handle: H) => { changed: boolean; result: R },
): Promise<EngineEdit<R>> {
  const { changed, result } = run(handle);
  return { changed, result, bytes: changed ? await handle.save() : null };
}

const editDocument = async <R>(bytes: Uint8Array, run: (document: DocxDocument) => { changed: boolean; result: R }) =>
  edit(await openDocx(bytes), run);
const editWorkbook = async <R>(path: string, bytes: Uint8Array, run: (workbook: Workbook) => { changed: boolean; result: R }) =>
  edit(await loadWorkbook(path, bytes), run);

/**
 * The ids the saved file gives the revisions an edit just made. The engine
 * numbers revisions when it opens a document, so the ids of the edited
 * document in memory are not the ids a later request sees. Both lists are in
 * document order; when they do not line up one to one, no id is returned and
 * the caller lists the revisions instead of acting on a wrong one.
 */
async function savedRevisionIds(edited: DocxDocument, saved: Uint8Array, ids: readonly string[]): Promise<string[]> {
  const before = edited.listRevisions();
  const after = (await openDocx(saved)).listRevisions();
  const aligned = before.length === after.length && before.every((revision, index) => {
    const twin = after[index];
    return twin !== undefined && twin.kind === revision.kind && twin.author === revision.author && twin.date === revision.date;
  });
  if (!aligned) {
    console.warn("[office-engine] saved revisions do not line up with the edit", { edited: before.length, saved: after.length });
    return [];
  }
  const savedIdOf = new Map(before.map((revision, index) => [revision.id, after[index]?.id]));
  return [...new Set(ids.flatMap((id) => savedIdOf.get(id) ?? []))];
}

export const ENGINE_OPERATIONS = {
  // ---- Documents ----
  async documentDescribe(input: { bytes: Uint8Array; options: { maxChars: number; startBlockId?: string; storyId?: string } }) {
    return describeDocument(await openDocx(input.bytes), input.options);
  },
  async documentReadText(input: {
    bytes: Uint8Array;
    request: { blockIds?: string[]; range?: TextRange; view: DocxTextView; maxChars: number };
  }) {
    return readDocumentText(await openDocx(input.bytes), input.request);
  },
  async documentProposeEdits(input: { bytes: Uint8Array; edits: readonly OfficeDocxEdit[]; author: string; date: string }) {
    const document = await openDocx(input.bytes);
    const { changed, ...result } = applyDocumentEdits(document, input.edits, input.author, input.date);
    if (!changed) return { changed, result, bytes: null };
    const bytes = await document.save();
    return { changed, result: { ...result, revisionIds: await savedRevisionIds(document, bytes, result.revisionIds) }, bytes };
  },
  async documentListRevisions(input: { bytes: Uint8Array }) {
    return listDocumentRevisions(await openDocx(input.bytes));
  },
  documentResolveRevisions(input: { bytes: Uint8Array; ids: Ids; accept: boolean }) {
    return editDocument(input.bytes, (document) => {
      const resolvedIds = resolveDocumentRevisions(document, input.ids, input.accept);
      return { changed: resolvedIds.length > 0, result: { resolvedIds } };
    });
  },
  documentAddComment(input: {
    bytes: Uint8Array;
    comment: { blockId: string; find: string; occurrence?: number; text: string };
    author: string;
    date: string;
  }) {
    return editDocument(input.bytes, (document) => ({
      changed: true,
      result: { commentId: addDocumentComment(document, input.comment, input.author, input.date) },
    }));
  },
  async documentCompare(input: { original: Uint8Array; revised: Uint8Array; author: string; date: string }) {
    const result = await compareDocxDetailed(input.original, input.revised, { author: input.author, date: input.date });
    const { identical, total, substantive, formattingOnly } = result.summary;
    return { summary: { identical, total, substantive, formattingOnly }, bytes: await result.document.save() };
  },
  async documentCreate(input: {
    markdown?: string;
    paragraphs?: readonly string[];
    options: { date: string; title?: string; author?: string };
  }) {
    const document = input.markdown !== undefined
      ? createDocxFromMarkdown(input.markdown, input.options)
      : createDocx({ ...input.options, paragraphs: [...(input.paragraphs ?? [])] });
    return { bytes: await document.save() };
  },

  // ---- Sheets ----
  async sheetDescribe(input: { path: string; bytes: Uint8Array; request: { sheet?: string; range?: string; maxChars: number } }) {
    return describeWorkbookSheet(await loadWorkbook(input.path, input.bytes), input.request);
  },
  async sheetReadRange(input: { path: string; bytes: Uint8Array; request: { sheet?: string; range: string } }) {
    return readWorkbookRange(await loadWorkbook(input.path, input.bytes), input.request);
  },
  sheetProposeEdits(input: {
    path: string;
    bytes: Uint8Array;
    edits: readonly OfficeSheetEdit[];
    proposal: { author: string; date: string; label: string };
  }) {
    return editWorkbook(input.path, input.bytes, (workbook) => {
      const { changed, ...result } = proposeWorkbookEdits(workbook, input.edits, input.proposal);
      return { changed, result };
    });
  },
  async sheetListChanges(input: { path: string; bytes: Uint8Array }) {
    return listWorkbookChanges(await loadWorkbook(input.path, input.bytes));
  },
  sheetResolveChanges(input: { path: string; bytes: Uint8Array; ids: Ids; accept: boolean }) {
    return editWorkbook(input.path, input.bytes, (workbook) => {
      const result = resolveWorkbookChanges(workbook, input.ids, input.accept);
      return { changed: result.resolvedIds.length > 0, result };
    });
  },
};

export type EngineOperation = keyof typeof ENGINE_OPERATIONS;
export type EngineInput<K extends EngineOperation> = Parameters<(typeof ENGINE_OPERATIONS)[K]>[0];
export type EngineOutput<K extends EngineOperation> = Awaited<ReturnType<(typeof ENGINE_OPERATIONS)[K]>>;

export function isEngineOperation(name: unknown): name is EngineOperation {
  return typeof name === "string" && Object.hasOwn(ENGINE_OPERATIONS, name);
}

/** Runs one operation on the calling thread. The engine thread calls this; so may a test. */
export function runEngineOperation<K extends EngineOperation>(operation: K, input: EngineInput<K>): Promise<EngineOutput<K>> {
  const run = ENGINE_OPERATIONS[operation] as (input: EngineInput<K>) => Promise<EngineOutput<K>>;
  return run(input);
}
