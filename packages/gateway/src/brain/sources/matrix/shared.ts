/**
 * Matrix sources: helpers every adapter shares. Document ids from the identity tuple, text cleaning and byte
 * cutting, versioned cursors, the notice list and the sweep step that tombstones documents whose item is gone.
 */
import { createHash } from "node:crypto";
import type { z } from "zod/v4";
import {
  BRAIN_DOCUMENT_ID_VERSIONS, BRAIN_SOURCE_NOTICES_MAX, type BrainConnectableSourceKind, type BrainSourceNotice,
  type BrainSourceReadContext, type BrainSourceReadResult,
} from "../../contracts.js";
import {
  BRAIN_DOCUMENT_MAX_BYTES, BRAIN_TITLE_MAX_CHARS, type BrainDocumentRef, type BrainSyncUpsertInput,
} from "../../types.js";
import { BRAIN_MATRIX_LIMITS, BrainMatrixPathError, BrainMatrixReaderError } from "./types.js";

export function matrixDocumentId(
  kind: BrainConnectableSourceKind, externalRef: string, tail: readonly (string | number)[],
): string {
  return createHash("sha256").update(JSON.stringify([BRAIN_DOCUMENT_ID_VERSIONS[kind], externalRef, ...tail]))
    .digest("hex");
}

/** No NUL, no lone surrogate (Postgres TEXT refuses the first, utf8 cannot carry the second). */
export function cleanText(value: string): string {
  return value.replaceAll("\u0000", "").toWellFormed();
}

/** At most maxBytes of utf8, cut on a character boundary. */
export function cutUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let cut = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").toWellFormed();
  while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1).toWellFormed();
  return cut;
}

/** A store-valid title: cleaned, whitespace collapsed, cut to the title bound; the fallback when nothing is left. */
export function documentTitle(value: string, fallback: string, suffix = ""): string {
  const text = cleanText(value).replace(/\s+/g, " ").trim();
  const room = BRAIN_TITLE_MAX_CHARS - suffix.length;
  let head = (text.length > 0 ? text : fallback).slice(0, room);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}${suffix}`;
}

/** The body fitted next to the title inside BRAIN_DOCUMENT_MAX_BYTES; cut reports whether text was dropped. */
export function fitBody(title: string, body: string): { readonly body: string; readonly cut: boolean } {
  const room = BRAIN_DOCUMENT_MAX_BYTES - Buffer.byteLength(title, "utf8");
  const fitted = cutUtf8(body, room);
  return { body: fitted, cut: fitted.length !== body.length };
}

/** UTC ISO instant, or null for anything that is not a date. */
export function isoInstant(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date === null || Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export class MatrixNotices {
  private readonly items: BrainSourceNotice[] = [];
  add(notice: BrainSourceNotice): void {
    if (this.items.length < BRAIN_SOURCE_NOTICES_MAX && !this.items.includes(notice)) this.items.push(notice);
  }
  list(): readonly BrainSourceNotice[] {
    return [...this.items];
  }
}

export function encodeMatrixCursor(prefix: string, state: unknown): string {
  return `${prefix}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

/** The stored cursor parsed with the adapter's strict schema; null for a cursor this adapter did not write. */
export function decodeMatrixCursor<T>(prefix: string, schema: z.ZodType<T>, text: string): T | null {
  if (!text.startsWith(prefix)) return null;
  const encoded = text.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Runs a reader call; any failure becomes BrainMatrixReaderError, logged by name only. */
export async function readThrough<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    console.error(`[brain-matrix] ${label} failed:`, error instanceof Error ? error.name : "UnknownError");
    throw new BrainMatrixReaderError({ cause: error });
  }
}

/** Expected adapter failures as result values; anything else propagates to the runner (internal_error). */
export async function guardRead(read: () => Promise<BrainSourceReadResult>): Promise<BrainSourceReadResult> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof BrainMatrixReaderError) return { ok: false, code: "provider_unavailable" };
    if (error instanceof BrainMatrixPathError) return { ok: false, code: "path_unsafe" };
    throw error;
  }
}

/** Accumulates one page within the runner's limits. */
export class MatrixPageDraft {
  readonly upserts: BrainSyncUpsertInput[] = [];
  readonly deletions: string[] = [];
  readonly notices = new MatrixNotices();
  skipped = 0;
  private refs = 0;

  constructor(private readonly context: BrainSourceReadContext<unknown>) {}

  /** Whether `count` more upserts carrying `refs` refs still fit. */
  fits(count: number, refs: number): boolean {
    const { limits } = this.context;
    return this.upserts.length + count <= limits.maxUpserts && this.refs + refs <= limits.maxRefs;
  }
  get deletionsFull(): boolean {
    return this.deletions.length >= this.context.limits.maxDeletions;
  }
  upsert(document: BrainSyncUpsertInput & { readonly refs: readonly BrainDocumentRef[] }): void {
    this.upserts.push(document);
    this.refs += document.refs.length;
  }
  /** Deletes the document when this source has a live one under that id (a skipped item that used to be synced). */
  async deleteIfLive(documentId: string): Promise<void> {
    const document = await this.context.documents.getDocument(this.context.scope, documentId);
    if (document !== null && document.deletedAt === null && document.sourceId === this.context.sourceId) {
      this.deletions.push(documentId);
    }
  }
  page(nextCursor: string, caughtUp: boolean): BrainSourceReadResult {
    return {
      ok: true,
      page: {
        upserts: this.upserts, deletions: this.deletions, nextCursor, caughtUp, skipped: this.skipped,
        notices: this.notices.list(),
      },
    };
  }
}

export interface MatrixSweepDocument {
  readonly documentId: string;
  readonly refs: readonly BrainDocumentRef[];
}

/**
 * One sweep step: the next page of this source's live documents after `after`, each kept or deleted by `keep`.
 * `full`, asked before every document but the first, ends the step early, and so does a `keep` that answers null
 * (out of room): the next step starts at that document. Null for the first document keeps it, so every step moves on.
 * Returns the cursor for the next step, or null when the sweep is done.
 */
export async function sweepStep(
  context: BrainSourceReadContext<unknown>,
  draft: MatrixPageDraft,
  after: string | null,
  keep: (document: MatrixSweepDocument) => Promise<boolean | null>,
  full: () => boolean = () => false,
): Promise<string | null> {
  const limit = Math.max(1, Math.min(BRAIN_MATRIX_LIMITS.sweepPageMax, context.limits.maxDeletions));
  const page = await context.documents.listDocuments(context.scope, {
    sourceId: context.sourceId, limit, cursor: after,
  });
  let last: string | null = null;
  for (const summary of page.items) {
    if (last !== null && full()) return last;
    const refs = await context.documents.listDocumentRefs(context.scope, summary.documentId);
    const kept = await keep({ documentId: summary.documentId, refs });
    if (kept === null && last !== null) return last;
    if (kept === false) draft.deletions.push(summary.documentId);
    last = summary.documentId;
  }
  return page.nextCursor;
}

/** Index of the first sorted key at or after `key`; the list length when there is none. */
export function resumeIndex(sorted: readonly string[], key: string): number {
  const index = sorted.findIndex((value) => value >= key);
  return index < 0 ? sorted.length : index;
}

export function firstRef(refs: readonly BrainDocumentRef[], kind: string): string | null {
  return refs.find((ref) => ref.kind === kind)?.value ?? null;
}
