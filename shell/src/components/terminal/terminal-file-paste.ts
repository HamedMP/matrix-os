export const BRACKETED_PASTE_OPEN = "\u001b[200~";
export const BRACKETED_PASTE_CLOSE = "\u001b[201~";

const BRACKETED_PASTE_OVERHEAD = BRACKETED_PASTE_OPEN.length + BRACKETED_PASTE_CLOSE.length;
const MAX_TERMINAL_INPUT = 65_536;
const SUPPORTED_TERMINAL_PASTE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TERMINAL_PASTE_UPLOAD_TIMEOUT_MS = 30_000;
const TERMINAL_PASTE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export function terminalPasteMimeType(file: File): string | null {
  const typed = file.type.trim().toLowerCase();
  if (SUPPORTED_TERMINAL_PASTE_MIME_TYPES.has(typed)) {
    return typed;
  }
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return TERMINAL_PASTE_MIME_BY_EXTENSION.get(file.name.slice(dot).toLowerCase()) ?? null;
}

function isSupportedTerminalPasteFile(file: File | null | undefined): file is File {
  return Boolean(file && terminalPasteMimeType(file));
}

export function filesFromTerminalFilePayload(
  payload: DataTransfer | ClipboardEvent["clipboardData"] | null,
): File[] {
  if (!payload) {
    return [];
  }
  const files: File[] = [];
  const items = Array.from(payload.items ?? []);
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (isSupportedTerminalPasteFile(file)) {
        files.push(file);
      }
    }
  }
  if (files.length > 0) {
    return files;
  }
  return Array.from(payload.files ?? []).filter(isSupportedTerminalPasteFile);
}

export function terminalPasteUploadTimeout(): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(TERMINAL_PASTE_UPLOAD_TIMEOUT_MS), cleanup: () => {} };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TERMINAL_PASTE_UPLOAD_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

export function splitBracketedPastePayload(parts: string[]): string[] {
  const maxPayloadLength = MAX_TERMINAL_INPUT - BRACKETED_PASTE_OVERHEAD;
  const payload = parts.filter((part) => part.length > 0).join(" ");
  const chunks: string[] = [];
  for (let index = 0; index < payload.length; index += maxPayloadLength) {
    chunks.push(payload.slice(index, index + maxPayloadLength));
  }
  return chunks;
}
