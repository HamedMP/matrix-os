/**
 * Attaching the owner's files to a draft through `MatrixOS.files`.
 *
 * A draft travels to the gateway as one JSON request of at most
 * `MAX_DRAFT_REQUEST_BYTES`, base64 attachment content included, so the room
 * for a file is what that budget leaves after the rest of the draft. The size
 * is checked with `stat` before anything is read, and again after reading.
 * Failures carry a fixed owner-facing sentence; bridge detail is only logged.
 */
import {
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFT_REQUEST_BYTES,
  draftRequestBytes,
  type Draft,
  type DraftAttachment,
} from "../../../_shared/office-accounts/types/mail";
import { officeAppFor } from "../ui/attachments";

export type ComposeAttachErrorCode = "too_large" | "too_many" | "not_found" | "forbidden" | "unavailable";

export const ATTACH_ERROR_MESSAGES: Readonly<Record<ComposeAttachErrorCode, string>> = Object.freeze({
  too_large: "This file is too large to attach to a message here.",
  too_many: "This message already has the most attachments it can carry.",
  not_found: "That file could not be found.",
  forbidden: "Mail is not allowed to read that file.",
  unavailable: "The file could not be read. Try again.",
});

export class ComposeAttachError extends Error {
  readonly code: ComposeAttachErrorCode;
  constructor(code: ComposeAttachErrorCode) {
    super(ATTACH_ERROR_MESSAGES[code]);
    this.name = "ComposeAttachError";
    this.code = code;
  }
}

/** The parts of `MatrixOS.files` the picker uses. */
export interface PickerFiles {
  list(dir: string, options?: { limit?: number }): Promise<{ entries: Array<{ name: string; path: string; kind: "file" | "dir"; size: number; modifiedAt: string }>; truncated: boolean }>;
  stat(path: string): Promise<{ path: string; size: number; modifiedAt: string; version: string }>;
  read(path: string): Promise<{ path: string; bytes: Uint8Array; size: number; version: string; mimeType: string }>;
}

const MIME: Readonly<Record<string, string>> = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
  zip: "application/zip",
  ics: "text/calendar",
});

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function mimeTypeFor(name: string, fallback: string): string {
  const known = MIME[extension(name)];
  if (known) return known;
  return /^[a-z]+\/[a-z0-9.+-]+$/i.test(fallback) ? fallback : "application/octet-stream";
}

export function fileKindLabel(name: string): string {
  const app = officeAppFor(name);
  return app === "docs" ? "Docs document" : app === "sheets" ? "Sheets workbook" : "File";
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard padded base64, without relying on `btoa` or Node buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    chunk += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
      + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=")
      + (i + 2 < bytes.length ? ALPHABET[n & 63] : "=");
    if (chunk.length >= 8192) {
      out.push(chunk);
      chunk = "";
    }
  }
  out.push(chunk);
  return out.join("");
}

/** Largest file (decoded bytes) named `name` that still fits in `draft`'s request. */
export function attachmentRoom(draft: Draft, name: string, mimeType = mimeTypeFor(name, "")): number {
  const probe: DraftAttachment = { name, mimeType, size: 0, contentBase64: "" };
  const base = draftRequestBytes({ ...draft, attachments: [...draft.attachments, probe] });
  const left = MAX_DRAFT_REQUEST_BYTES - base;
  if (left <= 0) return 0;
  return Math.floor(left / 4) * 3;
}

export type AttachCheck = { ok: true } | { ok: false; code: "too_large" | "too_many" };

export function checkAttachment(draft: Draft, name: string, size: number): AttachCheck {
  if (draft.attachments.length >= MAX_DRAFT_ATTACHMENTS) return { ok: false, code: "too_many" };
  if (!Number.isFinite(size) || size < 0 || size > attachmentRoom(draft, name)) return { ok: false, code: "too_large" };
  return { ok: true };
}

function bridgeCode(error: unknown): ComposeAttachErrorCode {
  const code = (error as { name?: unknown; code?: unknown } | null)?.name === "BridgeFileError" ? (error as { code?: unknown }).code : null;
  if (code === "not_found" || code === "forbidden" || code === "too_large") return code;
  return "unavailable";
}

/** Reads `path` as a draft attachment after checking that it fits `draft`. */
export async function readAttachment(files: PickerFiles, path: string, draft: Draft): Promise<DraftAttachment> {
  const name = baseName(path);
  let size: number;
  try {
    size = (await files.stat(path)).size;
  } catch (error: unknown) {
    console.warn(`[mail] attach.stat.failed (${error instanceof Error ? error.name : typeof error})`);
    throw new ComposeAttachError(bridgeCode(error));
  }
  const before = checkAttachment(draft, name, size);
  if (!before.ok) throw new ComposeAttachError(before.code);
  let content: Awaited<ReturnType<PickerFiles["read"]>>;
  try {
    content = await files.read(path);
  } catch (error: unknown) {
    console.warn(`[mail] attach.read.failed (${error instanceof Error ? error.name : typeof error})`);
    throw new ComposeAttachError(bridgeCode(error));
  }
  const bytes = content.bytes instanceof Uint8Array ? content.bytes : new Uint8Array(0);
  const after = checkAttachment(draft, name, bytes.length);
  if (!after.ok) throw new ComposeAttachError(after.code);
  return { name, mimeType: mimeTypeFor(name, content.mimeType), size: bytes.length, contentBase64: bytesToBase64(bytes) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}
