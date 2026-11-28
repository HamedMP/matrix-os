import {
  OFFICE_DOCUMENT_MAX_BUDGET_MS, OFFICE_DOCUMENT_MAX_BYTES,
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
import type { ProjectWriteGuard } from "../app-files/project-write-fence.js";
import { OfficeDeadline } from "./deadline.js";
import type { EngineEdit } from "./engine-operations.js";
import { sharedOfficeEngine, type OfficeEngine } from "./engine-pool.js";
import { OfficeDocumentError } from "./errors.js";
import { OfficeFileStore, type LoadedOfficeFile } from "./file-store.js";
import { KeyedMutex } from "./path-mutex.js";

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
  /** The collaboration project fence every save runs inside. */
  writeGuard?: ProjectWriteGuard;
  /** Where the engine runs. Defaults to the gateway's shared pool of engine threads. */
  engine?: OfficeEngine;
}

const UNTRUSTED = "untrusted" as const;

/** The deadline of a call that names none: the longest a caller may ask for. */
function defaultDeadline(): OfficeDeadline {
  return OfficeDeadline.after(OFFICE_DOCUMENT_MAX_BUDGET_MS);
}

/**
 * Runs the document engine on the owner's files. This thread only does file
 * I/O and locking; every engine call runs on an engine thread, so a slow
 * document never stalls the gateway. Reads load the file and ask the engine.
 * Edits run under a per-path mutex: load, check `ifVersion`, edit, save
 * atomically against the version that was loaded. An edit that changes
 * nothing does not write. Every call carries a deadline: a call past it
 * leaves the path queue, starts no engine run and saves nothing, so a caller
 * that was told it timed out never has the edit land later.
 */
export class OfficeDocumentService {
  private readonly store: OfficeFileStore;
  private readonly mutex: KeyedMutex;
  private readonly clock: () => Date;
  private readonly engine: OfficeEngine;

  constructor(options: OfficeDocumentServiceOptions) {
    this.store = new OfficeFileStore({
      homePath: options.homePath,
      maxFileBytes: options.maxFileBytes ?? OFFICE_DOCUMENT_MAX_BYTES,
      ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
      ...(options.writeGuard ? { writeGuard: options.writeGuard } : {}),
    });
    this.mutex = new KeyedMutex({ maxKeys: options.maxActivePaths ?? 64, maxWaitersPerKey: options.maxWaitersPerPath ?? 16 });
    this.clock = options.clock ?? (() => new Date());
    this.engine = options.engine ?? sharedOfficeEngine();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** Loads a file for a read; the engine run that follows starts only while the caller still waits. */
  private async load(path: string, deadline: OfficeDeadline): Promise<LoadedOfficeFile> {
    await this.store.assertAvailable();
    const file = await this.store.read(path);
    deadline.check("the engine run");
    return file;
  }

  /**
   * Load, check the caller's version, run the edit on an engine thread, save
   * when it changed something. The deadline is checked when the path is
   * free, before the engine run, before the save and again inside the save
   * right before it publishes.
   */
  private async edit<R>(
    path: string,
    ifVersion: string | undefined,
    deadline: OfficeDeadline,
    run: (file: LoadedOfficeFile) => Promise<EngineEdit<R>>,
  ): Promise<R & { version: string; saved: boolean }> {
    await this.store.assertAvailable();
    return this.mutex.run(path, async () => {
      const file = await this.store.read(path);
      if (ifVersion !== undefined && ifVersion !== file.version) throw new OfficeDocumentError("version_conflict", "stale ifVersion");
      deadline.check("the engine run");
      const { changed, result, bytes } = await run(file);
      if (!changed || !bytes) return { ...result, version: file.version, saved: false };
      deadline.check("the save");
      const committed = await this.store.commit(path, bytes, file.version, deadline);
      return { ...result, version: committed.version, saved: true };
    }, { deadline });
  }

  /** Creates a file that must not exist yet, with the same deadline checks as an edit. */
  private async create(path: string, deadline: OfficeDeadline, render: () => Promise<Uint8Array>) {
    await this.store.assertAvailable();
    await this.store.resolveWritable(path);
    return this.mutex.run(path, async () => {
      if (await this.store.currentVersion(await this.store.resolveWritable(path)) !== null) throw new OfficeDocumentError("file_exists");
      deadline.check("the engine run");
      const bytes = await render();
      deadline.check("the save");
      return this.store.commit(path, bytes, null, deadline);
    }, { deadline });
  }

  // ---- Documents ----

  async describeDocument(request: In<typeof DocumentDescribeRequestSchema>, deadline = defaultDeadline()): Promise<DocumentDescribeReply> {
    const file = await this.load(request.path, deadline);
    const described = await this.engine.run("documentDescribe", {
      bytes: file.bytes,
      options: {
        maxChars: request.maxChars,
        ...(request.startBlockId ? { startBlockId: request.startBlockId } : {}),
        ...(request.storyId ? { storyId: request.storyId } : {}),
      },
    }, { deadline });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...described };
  }

  async readDocumentText(request: In<typeof DocumentReadTextRequestSchema>, deadline = defaultDeadline()): Promise<DocumentReadTextReply> {
    const file = await this.load(request.path, deadline);
    const read = await this.engine.run("documentReadText", {
      bytes: file.bytes,
      request: {
        view: request.view, maxChars: request.maxChars,
        ...(request.blockIds ? { blockIds: request.blockIds } : {}),
        ...(request.range ? { range: request.range } : {}),
      },
    }, { deadline });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...read };
  }

  async proposeDocumentEdits(request: In<typeof DocumentProposeEditsRequestSchema>, deadline = defaultDeadline()): Promise<DocumentProposeEditsReply> {
    const date = this.now();
    const outcome = await this.edit(request.path, request.ifVersion, deadline, (file) => this.engine.run("documentProposeEdits", {
      bytes: file.bytes, edits: request.edits, author: request.author, date,
    }, { deadline }));
    return {
      path: request.path, version: outcome.version, saved: outcome.saved, revisionIds: outcome.revisionIds,
      commentIds: outcome.commentIds, appliedEdits: outcome.appliedEdits, rejected: outcome.rejected,
    };
  }

  async listDocumentRevisions(request: In<typeof DocumentPathRequestSchema>, deadline = defaultDeadline()): Promise<DocumentRevisionsListReply> {
    const file = await this.load(request.path, deadline);
    const listed = await this.engine.run("documentListRevisions", { bytes: file.bytes }, { deadline });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...listed };
  }

  async resolveDocumentRevisions(request: In<typeof DocumentResolveRevisionsRequestSchema>, accept: boolean, deadline = defaultDeadline()): Promise<DocumentResolveRevisionsReply> {
    const outcome = await this.edit(request.path, request.ifVersion, deadline, (file) => this.engine.run("documentResolveRevisions", {
      bytes: file.bytes, ids: request.ids, accept,
    }, { deadline }));
    return { path: request.path, version: outcome.version, saved: outcome.saved, resolvedIds: outcome.resolvedIds };
  }

  async addDocumentComment(request: In<typeof DocumentAddCommentRequestSchema>, deadline = defaultDeadline()): Promise<DocumentAddCommentReply> {
    const date = this.now();
    const outcome = await this.edit(request.path, request.ifVersion, deadline, (file) => this.engine.run("documentAddComment", {
      bytes: file.bytes,
      comment: {
        blockId: request.blockId, find: request.find, text: request.text,
        ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
      },
      author: request.author,
      date,
    }, { deadline }));
    return { path: request.path, version: outcome.version, commentId: outcome.commentId };
  }

  async compareDocuments(request: In<typeof DocumentCompareRequestSchema>, deadline = defaultDeadline()): Promise<DocumentCompareReply> {
    await this.store.assertAvailable();
    await this.store.resolveWritable(request.outputPath);
    const [original, revised] = await Promise.all([this.load(request.originalPath, deadline), this.load(request.revisedPath, deadline)]);
    const holder: { summary?: { identical: boolean; total: number; substantive: number; formattingOnly: number } } = {};
    const committed = await this.create(request.outputPath, deadline, async () => {
      const compared = await this.engine.run("documentCompare", {
        original: original.bytes, revised: revised.bytes, author: request.author, date: this.now(),
      }, { deadline });
      holder.summary = compared.summary;
      return compared.bytes;
    });
    const summary = holder.summary;
    if (!summary) throw new OfficeDocumentError("internal", "compare produced no summary");
    return {
      outputPath: committed.path, version: committed.version, identical: summary.identical, revisionCount: summary.total,
      substantive: summary.substantive, formattingOnly: summary.formattingOnly,
    };
  }

  async createDocument(request: In<typeof DocumentCreateRequestSchema>, deadline = defaultDeadline()): Promise<DocumentCreateReply> {
    const options = {
      date: this.now(),
      ...(request.title ? { title: request.title } : {}),
      ...(request.author ? { author: request.author } : {}),
    };
    const committed = await this.create(request.path, deadline, async () => (await this.engine.run("documentCreate", {
      options,
      ...(request.markdown !== undefined ? { markdown: request.markdown } : { paragraphs: request.paragraphs ?? [] }),
    }, { deadline })).bytes);
    return { path: committed.path, version: committed.version, size: committed.size };
  }

  // ---- Sheets ----

  async describeSheet(request: In<typeof SheetDescribeRequestSchema>, deadline = defaultDeadline()): Promise<SheetDescribeReply> {
    const file = await this.load(request.path, deadline);
    const described = await this.engine.run("sheetDescribe", {
      path: file.path,
      bytes: file.bytes,
      request: {
        maxChars: request.maxChars,
        ...(request.sheet ? { sheet: request.sheet } : {}),
        ...(request.range ? { range: request.range } : {}),
      },
    }, { deadline });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...described };
  }

  async readSheetRange(request: In<typeof SheetReadRangeRequestSchema>, deadline = defaultDeadline()): Promise<SheetReadRangeReply> {
    const file = await this.load(request.path, deadline);
    const read = await this.engine.run("sheetReadRange", {
      path: file.path, bytes: file.bytes, request: { range: request.range, ...(request.sheet ? { sheet: request.sheet } : {}) },
    }, { deadline });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...read };
  }

  async proposeSheetEdits(request: In<typeof SheetProposeEditsRequestSchema>, deadline = defaultDeadline()): Promise<SheetProposeEditsReply> {
    const proposal = { author: request.author, date: this.now(), label: request.label };
    const outcome = await this.edit(request.path, request.ifVersion, deadline, (file) => this.engine.run("sheetProposeEdits", {
      path: file.path, bytes: file.bytes, edits: request.edits, proposal,
    }, { deadline }));
    return {
      path: request.path, version: outcome.version, saved: outcome.saved, proposalId: outcome.proposalId,
      changeIds: outcome.changeIds, appliedEdits: outcome.appliedEdits, rejected: outcome.rejected,
    };
  }

  async listSheetChanges(request: In<typeof SheetPathRequestSchema>, deadline = defaultDeadline()): Promise<SheetChangesListReply> {
    const file = await this.load(request.path, deadline);
    const listed = await this.engine.run("sheetListChanges", { path: file.path, bytes: file.bytes }, { deadline });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...listed };
  }

  async resolveSheetChanges(request: In<typeof SheetResolveChangesRequestSchema>, accept: boolean, deadline = defaultDeadline()): Promise<SheetResolveChangesReply> {
    const outcome = await this.edit(request.path, request.ifVersion, deadline, (file) => this.engine.run("sheetResolveChanges", {
      path: file.path, bytes: file.bytes, ids: request.ids, accept,
    }, { deadline }));
    return { path: request.path, version: outcome.version, saved: outcome.saved, resolvedIds: outcome.resolvedIds, staleIds: outcome.staleIds };
  }
}
