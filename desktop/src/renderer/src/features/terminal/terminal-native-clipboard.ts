import { TerminalClipboardResultSchema } from "../../../../shared/terminal-clipboard";
import type { TerminalPasteFile } from "./terminal-rich-paste";

const ERRORS = {
  too_many_files: "Upload up to 8 files at a time.",
  too_large: "Files are limited to 10 MB.",
  file_unavailable: "Copied files are unavailable. Copy them again and try again.",
};
export class NativeTerminalClipboardError extends Error {}

export async function readNativeTerminalClipboardFiles(): Promise<TerminalPasteFile[]> {
  if (!window.operator?.invoke) return [];
  const result = TerminalClipboardResultSchema.parse(await window.operator.invoke("terminal:read-clipboard-files", {}));
  if (result.status === "empty") return [];
  if (result.status === "error") throw new NativeTerminalClipboardError(ERRORS[result.error]);
  return result.files.map(({ name, mimeType, dataBase64 }) => ({
    file: new File([Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0))], name, { type: mimeType }),
    mimeType,
  }));
}
