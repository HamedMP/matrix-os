// Local file helpers for the office apps. They use only standard browser APIs
// (a file input, DataTransfer, Blob URLs), so they work inside the sandboxed app
// iframe and in Electron Desktop without any host bridge.

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_MIME = "text/csv";
export const TSV_MIME = "text/tab-separated-values";

/** Largest local file the office apps open: 10 MiB. */
export const MAX_LOCAL_FILE_BYTES = 10 * 1024 * 1024;

/** How long to wait after focus returns before treating a silent picker as cancelled. */
const FOCUS_CANCEL_DELAY_MS = 1000;
/** Keep the Blob URL alive long enough for slow download starts. */
const REVOKE_DELAY_MS = 30_000;

export interface LocalFile {
  name: string;
  bytes: Uint8Array;
  lastModified: number;
}

export type LocalFileErrorCode = "no-file" | "multiple" | "wrong-type" | "too-large" | "read-failed";

/** Typed failure whose `message` is safe to show to the user as is. */
export class LocalFileError extends Error {
  readonly code: LocalFileErrorCode;
  constructor(code: LocalFileErrorCode, message: string) {
    super(message);
    this.name = "LocalFileError";
    this.code = code;
  }
}

export interface LocalFileOptions {
  /** Extensions (".docx") and MIME types ("text/csv", "text/*"). Empty accepts any file. */
  accept: readonly string[];
  /** Size limit in bytes (default MAX_LOCAL_FILE_BYTES). */
  maxBytes?: number;
}

function extensionList(accept: readonly string[]): string {
  const extensions = accept.filter((entry) => entry.startsWith("."));
  if (extensions.length === 0) return "supported";
  if (extensions.length === 1) return extensions[0];
  return `${extensions.slice(0, -1).join(", ")} or ${extensions[extensions.length - 1]}`;
}

function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${bytes} bytes`;
}

/** Short hint such as ".csv or .xlsx, up to 10 MB" for pickers and drop targets. */
export function describeAccept(accept: readonly string[], maxBytes = MAX_LOCAL_FILE_BYTES): string {
  const list = extensionList(accept);
  return list === "supported" ? `Up to ${formatLimit(maxBytes)}` : `${list}, up to ${formatLimit(maxBytes)}`;
}

/** True when the file's extension or MIME type matches an accept entry. */
export function fileMatchesAccept(file: Pick<File, "name" | "type">, accept: readonly string[]): boolean {
  if (accept.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return accept.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith(".")) return name.endsWith(entry);
    if (entry.endsWith("/*")) return type.startsWith(entry.slice(0, -1));
    return type === entry;
  });
}

/** Check type and size; throws LocalFileError with a human message. */
export function validateLocalFile(file: File, options: LocalFileOptions): void {
  const maxBytes = options.maxBytes ?? MAX_LOCAL_FILE_BYTES;
  if (!fileMatchesAccept(file, options.accept)) {
    throw new LocalFileError("wrong-type", `${file.name} can't be opened here. Choose a ${extensionList(options.accept)} file.`);
  }
  if (file.size > maxBytes) {
    throw new LocalFileError("too-large", `${file.name} is larger than ${formatLimit(maxBytes)}. Choose a smaller file.`);
  }
}

function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(file);
  });
}

async function toLocalFile(file: File, options: LocalFileOptions): Promise<LocalFile> {
  validateLocalFile(file, options);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file);
  } catch (error) {
    console.error("[office-ui] could not read local file", error instanceof Error ? error.name : typeof error);
    throw new LocalFileError("read-failed", `${file.name} could not be read. Try again.`);
  }
  return { name: file.name, bytes, lastModified: file.lastModified };
}

/** Only one picker is pending at a time; opening another settles the previous one with null. */
let cancelPendingPicker: (() => void) | null = null;

/**
 * Open the system file chooser. Resolves the chosen file, or null when the user
 * cancels (the input's "cancel" event, or focus returning with no file). Rejects
 * with LocalFileError when the file has the wrong type or is too large. Call it
 * from a click or key handler so the browser treats it as a user gesture.
 */
export function pickLocalFile(options: LocalFileOptions): Promise<LocalFile | null> {
  cancelPendingPicker?.();
  return new Promise<LocalFile | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept.join(",");
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      if (focusTimer) clearTimeout(focusTimer);
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      window.removeEventListener("focus", onFocus);
      input.remove();
      if (cancelPendingPicker === onCancel) cancelPendingPicker = null;
    };
    function onCancel() {
      if (settled) return;
      cleanup();
      resolve(null);
    }
    function onChange() {
      if (settled) return;
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      toLocalFile(file, options).then(resolve, reject);
    }
    function onFocus() {
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (!input.files || input.files.length === 0) onCancel();
      }, FOCUS_CANCEL_DELAY_MS);
    }

    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    window.addEventListener("focus", onFocus);
    cancelPendingPicker = onCancel;
    document.body.appendChild(input);
    input.click();
  });
}

/** Minimal DataTransfer shape, so tests and adapters can pass plain objects. */
export interface DroppedFiles {
  files: ArrayLike<File> | null;
}

/**
 * Read the single file from a drop. Rejects with LocalFileError when nothing,
 * several files, the wrong type or a file above the size limit was dropped.
 * The file list is read synchronously, so call it inside the drop handler.
 */
export function readDroppedFile(
  dataTransfer: DroppedFiles | null | undefined,
  accept: readonly string[],
  options: { maxBytes?: number } = {},
): Promise<LocalFile> {
  const files = dataTransfer?.files ? Array.from(dataTransfer.files) : [];
  if (files.length === 0) return Promise.reject(new LocalFileError("no-file", "No file was dropped."));
  if (files.length > 1) return Promise.reject(new LocalFileError("multiple", "Drop one file at a time."));
  return toLocalFile(files[0], { accept, maxBytes: options.maxBytes });
}

/** Keep only a plain file name: no folders, no control characters. */
export function safeDownloadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean && clean !== "." && clean !== ".." ? clean : "download";
}

/** Save bytes to the user's computer through a temporary Blob URL. */
export function downloadBytes(name: string, bytes: Uint8Array, mimeType: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeDownloadName(name);
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
