import { compareDocxDetailed, createDocx, createDocxFromMarkdown, openDocx } from "@matrix-os/office";
import type { DocxDocument, Workbook } from "@matrix-os/office";
import {
  OFFICE_DOCUMENT_MAX_BYTES,
  DocumentAddCommentRequestSchema, DocumentCompareRequestSchema, DocumentCreateRequestSchema, DocumentDescribeRequestSchema,
  DocumentPathRequestSchema, DocumentProposeEditsRequestSchema, DocumentReadTextRequestSchema,
  DocumentResolveRevisionsRequestSchema, SheetDescribeRequestSchema, SheetPathRequestSchema, SheetProposeEditsRequestSchema,
  SheetReadRangeRequestSchema, SheetResolveChangesRequestSchema,
  type DocumentAddCommentReply, type DocumentCompareReply, type DocumentCreateReply, type DocumentDescribeReply,
  type DocumentProposeEditsReply, type DocumentReadTextReply, type DocumentResolveRevisionsReply,
  type DocumentRevisionsListReply, type SheetChangesListReply, type SheetDescribeReply, type SheetProposeEditsReply,
  type SheetReadRangeReply, type SheetResolveChangesReply,
} from "@matrix-os/contracts/office-documents";
import type { z } from "zod/v4";
import {
  addDocumentComment, applyDocumentEdits, describeDocument, listDocumentRevisions, readDocumentText, resolveDocumentRevisions,
} from "./docx-operations.js";
import { OfficeDocumentError } from "./errors.js";
import { OfficeFileStore, type LoadedOfficeFile } from "./file-store.js";
import { KeyedMutex } from "./path-mutex.js";
import {
  describeWorkbookSheet, listWorkbookChanges, loadWorkbook, proposeWorkbookEdits, readWorkbookRange, resolveWorkbookChanges,
} from "./sheet-operations.js";

type In<S extends z.ZodType> = z.output<S>;

export interface OfficeDocumentServiceOptions {
  /** The owner's home directory. */
  homePath: string;
  /** Source of revision and change timestamps. */
  clock?: () => Date;
  maxFileBytes?: number;
  /** Paths that may be edited at once, and edits that may wait behind one path. */
  maxActivePaths?: number;
  maxWaitersPerPath?: number;
  /** Test seam: runs right before a save's version check. */
  beforeCommit?: (absolutePath: string) => Promise<void>;
}

const UNTRUSTED = "untrusted" as const;

/**
 * Runs the document engine on the owner's files. Reads open the file and
 * answer. Edits run under a per-path mutex: load, check `ifVersion`, edit,
 * save atomically against the version that was loaded. An edit that changes
 * nothing does not write.
 */
export class OfficeDocumentService {
  private readonly store: OfficeFileStore;
  private readonly mutex: KeyedMutex;
  private readonly clock: () => Date;

  constructor(options: OfficeDocumentServiceOptions) {
    this.store = new OfficeFileStore({
      homePath: options.homePath,
      maxFileBytes: options.maxFileBytes ?? OFFICE_DOCUMENT_MAX_BYTES,
      ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
    });
    this.mutex = new KeyedMutex({ maxKeys: options.maxActivePaths ?? 64, maxWaitersPerKey: options.maxWaitersPerPath ?? 16 });
    this.clock = options.clock ?? (() => new Date());
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async load(path: string): Promise<LoadedOfficeFile> {
    await this.store.assertAvailable();
    return this.store.read(path);
  }

  private async openDocument(path: string): Promise<{ file: LoadedOfficeFile; document: DocxDocument }> {
    const file = await this.load(path);
    return { file, document: await openDocx(file.bytes) };
  }

  private async openWorkbook(path: string): Promise<{ file: LoadedOfficeFile; workbook: Workbook }> {
    const file = await this.load(path);
    return { file, workbook: await loadWorkbook(path, file.bytes) };
  }

  /** Load, check the caller's version, run the edit, save when it changed something. */
  private async edit<H extends { save(): Promise<Uint8Array> }, R>(
    path: string,
    ifVersion: string | undefined,
    open: (path: string) => Promise<{ file: LoadedOfficeFile; handle: H }>,
    run: (handle: H) => { changed: boolean; result: R },
  ): Promise<R & { version: string; saved: boolean }> {
    await this.store.assertAvailable();
    return this.mutex.run(path, async () => {
      const { file, handle } = await open(path);
      if (ifVersion !== undefined && ifVersion !== file.version) throw new OfficeDocumentError("version_conflict", "stale ifVersion");
      const { changed, result } = run(handle);
      if (!changed) return { ...result, version: file.version, saved: false };
      const committed = await this.store.commit(path, await handle.save(), file.version);
      return { ...result, version: committed.version, saved: true };
    });
  }

  private editDocument<R>(path: string, ifVersion: string | undefined, run: (document: DocxDocument) => { changed: boolean; result: R }) {
    return this.edit(path, ifVersion, async (p) => {
      const { file, document } = await this.openDocument(p);
      return { file, handle: document };
    }, run);
  }

  private editWorkbook<R>(path: string, ifVersion: string | undefined, run: (workbook: Workbook) => { changed: boolean; result: R }) {
    return this.edit(path, ifVersion, async (p) => {
      const { file, workbook } = await this.openWorkbook(p);
      return { file, handle: workbook };
    }, run);
  }

  /** Creates a file that must not exist yet. */
  private async create(path: string, render: () => Promise<Uint8Array>) {
    await this.store.assertAvailable();
    await this.store.resolveWritable(path);
    return this.mutex.run(path, async () => {
      if (await this.store.currentVersion(await this.store.resolveWritable(path)) !== null) throw new OfficeDocumentError("file_exists");
      return this.store.commit(path, await render(), null);
    });
  }

  // ---- Documents ----

  async describeDocument(request: In<typeof DocumentDescribeRequestSchema>): Promise<DocumentDescribeReply> {
    const { file, document } = await this.openDocument(request.path);
    return {
      path: file.path, version: file.version, trust: UNTRUSTED,
      ...describeDocument(document, {
        maxChars: request.maxChars,
        ...(request.startBlockId ? { startBlockId: request.startBlockId } : {}),
        ...(request.storyId ? { storyId: request.storyId } : {}),
      }),
    };
  }

  async readDocumentText(request: In<typeof DocumentReadTextRequestSchema>): Promise<DocumentReadTextReply> {
    const { file, document } = await this.openDocument(request.path);
    return {
      path: file.path, version: file.version, trust: UNTRUSTED,
      ...readDocumentText(document, {
        view: request.view, maxChars: request.maxChars,
        ...(request.blockIds ? { blockIds: request.blockIds } : {}),
        ...(request.range ? { range: request.range } : {}),
      }),
    };
  }

  async proposeDocumentEdits(request: In<typeof DocumentProposeEditsRequestSchema>): Promise<DocumentProposeEditsReply> {
    const date = this.now();
    const outcome = await this.editDocument(request.path, request.ifVersion, (document) => {
      const { changed, ...result } = applyDocumentEdits(document, request.edits, request.author, date);
      return { changed, result };
    });
    return {
      path: request.path, version: outcome.version, saved: outcome.saved, revisionIds: outcome.revisionIds,
      commentIds: outcome.commentIds, appliedEdits: outcome.appliedEdits, rejected: outcome.rejected,
    };
  }

  async listDocumentRevisions(request: In<typeof DocumentPathRequestSchema>): Promise<DocumentRevisionsListReply> {
    const { file, document } = await this.openDocument(request.path);
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...listDocumentRevisions(document) };
  }

  async resolveDocumentRevisions(request: In<typeof DocumentResolveRevisionsRequestSchema>, accept: boolean): Promise<DocumentResolveRevisionsReply> {
    const outcome = await this.editDocument(request.path, request.ifVersion, (document) => {
      const resolvedIds = resolveDocumentRevisions(document, request.ids, accept);
      return { changed: resolvedIds.length > 0, result: { resolvedIds } };
    });
    return { path: request.path, version: outcome.version, saved: outcome.saved, resolvedIds: outcome.resolvedIds };
  }

  async addDocumentComment(request: In<typeof DocumentAddCommentRequestSchema>): Promise<DocumentAddCommentReply> {
    const date = this.now();
    const outcome = await this.editDocument(request.path, request.ifVersion, (document) => ({
      changed: true,
      result: {
        commentId: addDocumentComment(document, {
          blockId: request.blockId, find: request.find, text: request.text,
          ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
        }, request.author, date),
      },
    }));
    return { path: request.path, version: outcome.version, commentId: outcome.commentId };
  }

  async compareDocuments(request: In<typeof DocumentCompareRequestSchema>): Promise<DocumentCompareReply> {
    await this.store.assertAvailable();
    await this.store.resolveWritable(request.outputPath);
    const [original, revised] = await Promise.all([this.load(request.originalPath), this.load(request.revisedPath)]);
    const holder: { summary?: { identical: boolean; total: number; substantive: number; formattingOnly: number } } = {};
    const committed = await this.create(request.outputPath, async () => {
      const result = await compareDocxDetailed(original.bytes, revised.bytes, { author: request.author, date: this.now() });
      holder.summary = result.summary;
      return result.document.save();
    });
    const summary = holder.summary;
    if (!summary) throw new OfficeDocumentError("internal", "compare produced no summary");
    return {
      outputPath: committed.path, version: committed.version, identical: summary.identical, revisionCount: summary.total,
      substantive: summary.substantive, formattingOnly: summary.formattingOnly,
    };
  }

  async createDocument(request: In<typeof DocumentCreateRequestSchema>): Promise<DocumentCreateReply> {
    const options = {
      date: this.now(),
      ...(request.title ? { title: request.title } : {}),
      ...(request.author ? { author: request.author } : {}),
    };
    const committed = await this.create(request.path, () => {
      const document = request.markdown !== undefined
        ? createDocxFromMarkdown(request.markdown, options)
        : createDocx({ ...options, paragraphs: request.paragraphs ?? [] });
      return document.save();
    });
    return { path: committed.path, version: committed.version, size: committed.size };
  }

  // ---- Sheets ----

  async describeSheet(request: In<typeof SheetDescribeRequestSchema>): Promise<SheetDescribeReply> {
    const { file, workbook } = await this.openWorkbook(request.path);
    return {
      path: file.path, version: file.version, trust: UNTRUSTED,
      ...describeWorkbookSheet(workbook, {
        maxChars: request.maxChars,
        ...(request.sheet ? { sheet: request.sheet } : {}),
        ...(request.range ? { range: request.range } : {}),
      }),
    };
  }

  async readSheetRange(request: In<typeof SheetReadRangeRequestSchema>): Promise<SheetReadRangeReply> {
    const { file, workbook } = await this.openWorkbook(request.path);
    return {
      path: file.path, version: file.version, trust: UNTRUSTED,
      ...readWorkbookRange(workbook, { range: request.range, ...(request.sheet ? { sheet: request.sheet } : {}) }),
    };
  }

  async proposeSheetEdits(request: In<typeof SheetProposeEditsRequestSchema>): Promise<SheetProposeEditsReply> {
    const proposal = { author: request.author, date: this.now(), label: request.label };
    const outcome = await this.editWorkbook(request.path, request.ifVersion, (workbook) => {
      const { changed, ...result } = proposeWorkbookEdits(workbook, request.edits, proposal);
      return { changed, result };
    });
    return {
      path: request.path, version: outcome.version, saved: outcome.saved, proposalId: outcome.proposalId,
      changeIds: outcome.changeIds, appliedEdits: outcome.appliedEdits, rejected: outcome.rejected,
    };
  }

  async listSheetChanges(request: In<typeof SheetPathRequestSchema>): Promise<SheetChangesListReply> {
    const { file, workbook } = await this.openWorkbook(request.path);
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...listWorkbookChanges(workbook) };
  }

  async resolveSheetChanges(request: In<typeof SheetResolveChangesRequestSchema>, accept: boolean): Promise<SheetResolveChangesReply> {
    const outcome = await this.editWorkbook(request.path, request.ifVersion, (workbook) => {
      const result = resolveWorkbookChanges(workbook, request.ids, accept);
      return { changed: result.resolvedIds.length > 0, result };
    });
    return { path: request.path, version: outcome.version, saved: outcome.saved, resolvedIds: outcome.resolvedIds, staleIds: outcome.staleIds };
  }
}
