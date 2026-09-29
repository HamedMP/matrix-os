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
