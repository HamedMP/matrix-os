const BRACKETED_PASTE_OPEN = "\x1b[200~";
const BRACKETED_PASTE_CLOSE = "\x1b[201~";
const MAX_TERMINAL_INPUT = 65_536;
export const MAX_TERMINAL_PASTE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TERMINAL_PASTE_FILES = 8;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export type TerminalPasteFile = { file: File; mimeType: string };

type ClipboardLike = {
  read?: () => Promise<Array<{ types: readonly string[]; getType(type: string): Promise<Blob> }>>;
};

export function terminalPasteMimeType(file: File): string | null {
  const typed = file.type.trim().toLowerCase();
  if (SUPPORTED_MIME_TYPES.has(typed)) return typed;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) return null;
  return MIME_BY_EXTENSION.get(file.name.slice(dot).toLowerCase()) ?? null;
}

function supportedFile(file: File | null | undefined): TerminalPasteFile | null {
  if (!file) return null;
  const mimeType = terminalPasteMimeType(file);
  return mimeType ? { file, mimeType } : null;
}

export function terminalPasteFiles(
  payload: Pick<DataTransfer, "files" | "items"> | DataTransfer | null,
): TerminalPasteFile[] {
  if (!payload) return [];
  const fromItems = Array.from(payload.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) return [];
    const supported = supportedFile(item.getAsFile());
    return supported ? [supported] : [];
  });
  const files = fromItems.length > 0
    ? fromItems
    : Array.from(payload.files ?? []).flatMap((file) => {
        const supported = supportedFile(file);
        return supported ? [supported] : [];
      });
  return files.slice(0, MAX_TERMINAL_PASTE_FILES);
}

export async function readTerminalClipboardFiles(
  clipboard: ClipboardLike | undefined,
): Promise<TerminalPasteFile[]> {
  if (!clipboard?.read) return [];
  const items = await clipboard.read();
  const supportedItems = items.flatMap((item) => {
    const mimeType = item.types.find((type) => SUPPORTED_MIME_TYPES.has(type.toLowerCase()));
    return mimeType ? [{ item, mimeType }] : [];
  }).slice(0, MAX_TERMINAL_PASTE_FILES);
  return Promise.all(supportedItems.map(async ({ item, mimeType }) => {
    const blob = await item.getType(mimeType);
    return {
      file: new File([blob], "clipboard-image", { type: mimeType }),
      mimeType,
    };
  }));
}

export function bracketTerminalPaths(paths: readonly string[]): string {
  const safe = paths
    .filter((path) => /^\/home\/matrix\/home\/[^\u0000\r\n]*$/.test(path))
    .join(" ")
    .replace(/\x1b\[20[01]~/g, "");
  const maxPayload = MAX_TERMINAL_INPUT - BRACKETED_PASTE_OPEN.length - BRACKETED_PASTE_CLOSE.length;
  return `${BRACKETED_PASTE_OPEN}${safe.slice(0, maxPayload)}${BRACKETED_PASTE_CLOSE}`;
}

export function safeTerminalUploadFilename(fileName: string): string {
  const safe = fileName.replace(/[/\\\u0000-\u001f\u007f]+/g, "-").slice(0, 255);
  return safe && safe !== "." && safe !== ".." ? safe : "paste-image";
}
