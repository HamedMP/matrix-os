/** Accept file drags without reading their protected payload before drop. */
export function captureTerminalFileDrag(event: DragEvent): void {
  const payload = event.dataTransfer;
  if (!payload) return;
  const hasFiles = Array.from(payload.types ?? []).includes("Files")
    || Array.from(payload.items ?? []).some((item) => item.kind === "file");
  if (!hasFiles) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  payload.dropEffect = "copy";
}

export const MAX_TERMINAL_DROP_FILES = 8;
export const MAX_TERMINAL_DROP_FILE_BYTES = 10 * 1024 * 1024;

/** Null rejects unreadable/folder batches; keep one over the limit for validation. */
export function terminalDropFiles(payload: DataTransfer | null): File[] | null {
  if (!payload) return [];
  const files: File[] = [];
  let hasFileItems = false;
  for (const item of Array.from(payload.items ?? [])) {
    if (item.kind !== "file") continue;
    hasFileItems = true;
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) return null;
    const file = item.getAsFile();
    if (!file) return null;
    files.push(file);
    if (files.length > MAX_TERMINAL_DROP_FILES) break;
  }
  return hasFileItems ? files : Array.from(payload.files ?? []).slice(0, MAX_TERMINAL_DROP_FILES + 1);
}

export function terminalDropMimeType(file: File): string {
  return file.type.trim().toLowerCase() || "application/octet-stream";
}
