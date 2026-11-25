/**
 * Opening and saving mail attachments.
 *
 * `.docx` goes to Docs and `.xlsx`/`.csv`/`.tsv` to Sheets: the file is saved
 * into the owner's home through `MatrixOS.files`, then handed to the app with
 * the open-with request (`files.openWith`, when the host offers it). Anything
 * else, or a host without file access, is downloaded. Attachment bytes and
 * names are untrusted: the name is reduced to a safe file name and downloads
 * are typed as opaque bytes so nothing renders inline.
 */
import type { MailAttachment, MailProvider } from "../../../_shared/office-accounts/types/mail";

export type OfficeApp = "docs" | "sheets";

const OFFICE_TYPES: Readonly<Record<string, OfficeApp>> = Object.freeze({ docx: "docs", xlsx: "sheets", csv: "sheets", tsv: "sheets" });
export const OFFICE_APP_TITLES: Readonly<Record<OfficeApp, string>> = Object.freeze({ docs: "Docs", sheets: "Sheets" });
export const ATTACHMENT_FOLDER = "Documents/Mail attachments";
const MAX_NAME_CHARS = 120;
const MAX_SAVE_ATTEMPTS = 20;
const DOWNLOAD_URL_TTL_MS = 60_000;

/** The app that opens this file name, or null. Mirrors the shared open-with table. */
export function officeAppFor(name: string): OfficeApp | null {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || base.startsWith("~$")) return null;
  return OFFICE_TYPES[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** One path segment, no separators, controls or dot-only names, at most 120 characters. */
export function safeFileName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/\s+/g, " ").trim();
  clean = clean.replace(/^\.+/, "").trim();
  if (!clean) return "attachment";
  if (clean.length > MAX_NAME_CHARS) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
    clean = clean.slice(0, MAX_NAME_CHARS - ext.length).trimEnd() + ext;
  }
  return clean;
}

/** Home-relative path for the `attempt`-th try at saving `name` (0 is the plain name). */
export function attachmentSavePath(name: string, attempt: number): string {
  const safe = safeFileName(name);
  if (attempt <= 0) return `${ATTACHMENT_FOLDER}/${safe}`;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  return `${ATTACHMENT_FOLDER}/${stem} (${attempt})${ext}`;
}

/** The parts of `window.MatrixOS` this module uses. */
export interface AttachmentBridge {
  files?: {
    write(path: string, bytes: Uint8Array, options: { ifVersion: string | null; createParents?: boolean }): Promise<{ path: string }>;
    /** Hands a home file to its default app (open-with). Not every host offers it. */
    openWith?: (path: string) => Promise<unknown>;
  };
  openApp?: (name: string, path: string) => void;
}

export type AttachmentOutcome =
  | { kind: "opened"; app: OfficeApp; path: string }
  /** Saved to the home; the host could not hand it to the app. */
  | { kind: "saved"; app: OfficeApp; path: string }
  | { kind: "downloaded"; name: string }
  | { kind: "failed" };

export interface AttachmentDeps {
  provider: MailProvider;
  messageId: string;
  attachment: MailAttachment;
  bridge?: AttachmentBridge;
  /** Saves bytes as a browser download. Injected for tests. */
  download?: (name: string, bytes: Uint8Array) => void;
}

export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Starts a browser download of opaque bytes. */
export function downloadBytes(name: string, bytes: Uint8Array): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFileName(name);
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function fileErrorCode(error: unknown): string | null {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  return candidate && candidate.name === "BridgeFileError" && typeof candidate.code === "string" ? candidate.code : null;
}

async function saveToHome(files: NonNullable<AttachmentBridge["files"]>, name: string, bytes: Uint8Array): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
    try {
      return (await files.write(attachmentSavePath(name, attempt), bytes, { ifVersion: null, createParents: true })).path;
    } catch (error: unknown) {
      if (fileErrorCode(error) === "version_conflict") continue;
      console.warn(`[mail] attachment.save.failed (${fileErrorCode(error) ?? errorName(error)})`);
      return null;
    }
  }
  return null;
}

/** Opens a document or spreadsheet in its app, or downloads anything else. */
export async function openAttachment(deps: AttachmentDeps): Promise<AttachmentOutcome> {
  const download = deps.download ?? downloadBytes;
  let bytes: Uint8Array;
  try {
    const content = await deps.provider.getAttachment(deps.messageId, deps.attachment.id);
    bytes = base64ToBytes(content.contentBase64);
  } catch (error: unknown) {
    console.warn(`[mail] attachment.fetch.failed (${errorName(error)})`);
    return { kind: "failed" };
  }
  const app = officeAppFor(deps.attachment.name);
  const files = deps.bridge?.files;
  if (app && files && typeof files.write === "function") {
    const path = await saveToHome(files, deps.attachment.name, bytes);
    if (path) {
      if (typeof files.openWith === "function") {
        try {
          await files.openWith(path);
          return { kind: "opened", app, path };
        } catch (error: unknown) {
          console.warn(`[mail] attachment.open.failed (${errorName(error)})`);
        }
      }
      return { kind: "saved", app, path };
    }
  }
  download(deps.attachment.name, bytes);
  return { kind: "downloaded", name: safeFileName(deps.attachment.name) };
}

/** Always downloads, whatever the type. */
export async function downloadAttachment(deps: AttachmentDeps): Promise<AttachmentOutcome> {
  return openAttachment({ ...deps, bridge: undefined });
}
