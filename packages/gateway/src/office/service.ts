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
import type { ProjectWriteGuard } from "../app-files/project-write-fence.js";
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

/**
 * Runs the document engine on the owner's files. This thread only does file
 * I/O and locking; every engine call runs on an engine thread, so a slow
 * document never stalls the gateway. Reads load the file and ask the engine.
 * Edits run under a per-path mutex: load, check `ifVersion`, edit, save
 * atomically against the version that was loaded. An edit that changes
 * nothing does not write.
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

  private async load(path: string): Promise<LoadedOfficeFile> {
    await this.store.assertAvailable();
    return this.store.read(path);
  }

  /** Load, check the caller's version, run the edit on an engine thread, save when it changed something. */
  private async edit<R>(
    path: string,
    ifVersion: string | undefined,
    run: (file: LoadedOfficeFile) => Promise<EngineEdit<R>>,
  ): Promise<R & { version: string; saved: boolean }> {
    await this.store.assertAvailable();
    return this.mutex.run(path, async () => {
      const file = await this.store.read(path);
      if (ifVersion !== undefined && ifVersion !== file.version) throw new OfficeDocumentError("version_conflict", "stale ifVersion");
      const { changed, result, bytes } = await run(file);
      if (!changed || !bytes) return { ...result, version: file.version, saved: false };
      const committed = await this.store.commit(path, bytes, file.version);
      return { ...result, version: committed.version, saved: true };
    });
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
    const file = await this.load(request.path);
    const described = await this.engine.run("documentDescribe", {
      bytes: file.bytes,
      options: {
        maxChars: request.maxChars,
        ...(request.startBlockId ? { startBlockId: request.startBlockId } : {}),
        ...(request.storyId ? { storyId: request.storyId } : {}),
      },
    });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...described };
  }

  async readDocumentText(request: In<typeof DocumentReadTextRequestSchema>): Promise<DocumentReadTextReply> {
    const file = await this.load(request.path);
    const read = await this.engine.run("documentReadText", {
      bytes: file.bytes,
      request: {
        view: request.view, maxChars: request.maxChars,
        ...(request.blockIds ? { blockIds: request.blockIds } : {}),
        ...(request.range ? { range: request.range } : {}),
      },
    });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...read };
  }

  async proposeDocumentEdits(request: In<typeof DocumentProposeEditsRequestSchema>): Promise<DocumentProposeEditsReply> {
    const date = this.now();
    const outcome = await this.edit(request.path, request.ifVersion, (file) => this.engine.run("documentProposeEdits", {
      bytes: file.bytes, edits: request.edits, author: request.author, date,
    }));
    return {
      path: request.path, version: outcome.version, saved: outcome.saved, revisionIds: outcome.revisionIds,
      commentIds: outcome.commentIds, appliedEdits: outcome.appliedEdits, rejected: outcome.rejected,
    };
  }

  async listDocumentRevisions(request: In<typeof DocumentPathRequestSchema>): Promise<DocumentRevisionsListReply> {
    const file = await this.load(request.path);
    const listed = await this.engine.run("documentListRevisions", { bytes: file.bytes });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...listed };
  }

  async resolveDocumentRevisions(request: In<typeof DocumentResolveRevisionsRequestSchema>, accept: boolean): Promise<DocumentResolveRevisionsReply> {
    const outcome = await this.edit(request.path, request.ifVersion, (file) => this.engine.run("documentResolveRevisions", {
      bytes: file.bytes, ids: request.ids, accept,
    }));
    return { path: request.path, version: outcome.version, saved: outcome.saved, resolvedIds: outcome.resolvedIds };
  }

  async addDocumentComment(request: In<typeof DocumentAddCommentRequestSchema>): Promise<DocumentAddCommentReply> {
    const date = this.now();
    const outcome = await this.edit(request.path, request.ifVersion, (file) => this.engine.run("documentAddComment", {
      bytes: file.bytes,
      comment: {
        blockId: request.blockId, find: request.find, text: request.text,
        ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
      },
      author: request.author,
      date,
    }));
    return { path: request.path, version: outcome.version, commentId: outcome.commentId };
  }

  async compareDocuments(request: In<typeof DocumentCompareRequestSchema>): Promise<DocumentCompareReply> {
    await this.store.assertAvailable();
    await this.store.resolveWritable(request.outputPath);
    const [original, revised] = await Promise.all([this.load(request.originalPath), this.load(request.revisedPath)]);
    const holder: { summary?: { identical: boolean; total: number; substantive: number; formattingOnly: number } } = {};
    const committed = await this.create(request.outputPath, async () => {
      const compared = await this.engine.run("documentCompare", {
        original: original.bytes, revised: revised.bytes, author: request.author, date: this.now(),
      });
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

  async createDocument(request: In<typeof DocumentCreateRequestSchema>): Promise<DocumentCreateReply> {
    const options = {
      date: this.now(),
      ...(request.title ? { title: request.title } : {}),
      ...(request.author ? { author: request.author } : {}),
    };
    const committed = await this.create(request.path, async () => (await this.engine.run("documentCreate", {
      options,
      ...(request.markdown !== undefined ? { markdown: request.markdown } : { paragraphs: request.paragraphs ?? [] }),
    })).bytes);
    return { path: committed.path, version: committed.version, size: committed.size };
  }

  // ---- Sheets ----

  async describeSheet(request: In<typeof SheetDescribeRequestSchema>): Promise<SheetDescribeReply> {
    const file = await this.load(request.path);
    const described = await this.engine.run("sheetDescribe", {
      path: file.path,
      bytes: file.bytes,
      request: {
        maxChars: request.maxChars,
        ...(request.sheet ? { sheet: request.sheet } : {}),
        ...(request.range ? { range: request.range } : {}),
      },
    });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...described };
  }

  async readSheetRange(request: In<typeof SheetReadRangeRequestSchema>): Promise<SheetReadRangeReply> {
    const file = await this.load(request.path);
    const read = await this.engine.run("sheetReadRange", {
      path: file.path, bytes: file.bytes, request: { range: request.range, ...(request.sheet ? { sheet: request.sheet } : {}) },
    });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...read };
  }

  async proposeSheetEdits(request: In<typeof SheetProposeEditsRequestSchema>): Promise<SheetProposeEditsReply> {
    const proposal = { author: request.author, date: this.now(), label: request.label };
    const outcome = await this.edit(request.path, request.ifVersion, (file) => this.engine.run("sheetProposeEdits", {
      path: file.path, bytes: file.bytes, edits: request.edits, proposal,
    }));
    return {
      path: request.path, version: outcome.version, saved: outcome.saved, proposalId: outcome.proposalId,
      changeIds: outcome.changeIds, appliedEdits: outcome.appliedEdits, rejected: outcome.rejected,
    };
  }

  async listSheetChanges(request: In<typeof SheetPathRequestSchema>): Promise<SheetChangesListReply> {
    const file = await this.load(request.path);
    const listed = await this.engine.run("sheetListChanges", { path: file.path, bytes: file.bytes });
    return { path: file.path, version: file.version, trust: UNTRUSTED, ...listed };
  }

  async resolveSheetChanges(request: In<typeof SheetResolveChangesRequestSchema>, accept: boolean): Promise<SheetResolveChangesReply> {
    const outcome = await this.edit(request.path, request.ifVersion, (file) => this.engine.run("sheetResolveChanges", {
      path: file.path, bytes: file.bytes, ids: request.ids, accept,
    }));
    return { path: request.path, version: outcome.version, saved: outcome.saved, resolvedIds: outcome.resolvedIds, staleIds: outcome.staleIds };
  }
}
