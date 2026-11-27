import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { INVOKE_CHANNELS } from "../../shared/ipc-contract";
import {
  TERMINAL_CLIPBOARD_MAX_BYTES, TERMINAL_CLIPBOARD_MAX_FILES,
  TerminalClipboardResultSchema, type TerminalClipboardResult,
} from "../../shared/terminal-clipboard";

// The Electron 44+ main-process clipboard (W3C-style, asynchronous).
interface FileClipboard {
  has(mimeType: string): Promise<boolean>;
  read(): Promise<Array<{ readonly types: readonly string[]; getType(type: string): Promise<unknown> }>>;
}
// On macOS Electron maps text/uri-list to Finder's native copied-files format
// (NSFilenamesPboardType). Its payload is an RFC 2483 list of file:// URIs.
const FILE_LIST_MIME = "text/uri-list";
const MAX_METADATA_BYTES = 64 * 1024;

async function readFileList(clipboard: FileClipboard): Promise<string | null> {
  const item = (await clipboard.read()).find((candidate) => candidate.types.includes(FILE_LIST_MIME));
  if (!item) return null;
  const blob = await item.getType(FILE_LIST_MIME);
  if (!(blob instanceof Blob) || blob.size > MAX_METADATA_BYTES) return null;
  return blob.text();
}

export async function readTerminalClipboardFiles(
  clipboard: FileClipboard,
  platform: string = process.platform,
): Promise<TerminalClipboardResult> {
  // Finder file copy is the native format supported here. Other platforms
  // retain the existing text/image clipboard path and local file drag/drop.
  if (platform !== "darwin") return { status: "empty" };
  try {
    if (!(await clipboard.has(FILE_LIST_MIME))) return { status: "empty" };
    const list = await readFileList(clipboard);
    if (list === null) return { status: "error", error: "file_unavailable" };
    const uris = list.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    // A URI list with no copied file behind it stays ordinary text paste.
    if (!uris.some((uri) => uri.startsWith("file:"))) return { status: "empty" };
    if (uris.length > TERMINAL_CLIPBOARD_MAX_FILES) return { status: "error", error: "too_many_files" };
    // fileURLToPath rejects non-file schemes, remote hosts and encoded NULs.
    const paths = uris.map((uri) => fileURLToPath(uri));
    const files: Array<{ name: string; mimeType: "application/octet-stream"; dataBase64: string }> = [];
    for (const path of paths) {
      if (!isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path)) {
        return { status: "error", error: "file_unavailable" };
      }
      const name = basename(path);
      if (!name || name.length > 255) return { status: "error", error: "file_unavailable" };
      // Do not follow symlinks or block on pipes/devices from clipboard data.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return { status: "error", error: "file_unavailable" };
        if (stat.size > TERMINAL_CLIPBOARD_MAX_BYTES) return { status: "error", error: "too_large" };
        const bytes = Buffer.alloc(TERMINAL_CLIPBOARD_MAX_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size > TERMINAL_CLIPBOARD_MAX_BYTES) return { status: "error", error: "too_large" };
        files.push({ name, mimeType: "application/octet-stream", dataBase64: bytes.subarray(0, size).toString("base64") });
      } finally { await handle.close(); }
    }
    return { status: "files", files };
  } catch (error: unknown) {
    console.warn("[terminal] native clipboard file read failed", { category: error instanceof Error ? error.name : "clipboard-error" });
    return { status: "error", error: "file_unavailable" };
  }
}

export function registerTerminalClipboardIpc(ipc: {
  handle(channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>): void;
}, options: {
  clipboard: FileClipboard;
  platform?: string;
  isTrustedSender(event: unknown): boolean;
}): void {
  if (typeof options.clipboard?.read !== "function" || typeof options.clipboard?.has !== "function" || typeof options.isTrustedSender !== "function") {
    throw new Error("clipboard service unavailable");
  }
  let inFlight = false;
  ipc.handle("terminal:read-clipboard-files", async (event, payload) => {
    if (!INVOKE_CHANNELS["terminal:read-clipboard-files"].request.safeParse(payload ?? {}).success
      || !options.isTrustedSender(event)) throw new Error("invalid request");
    if (inFlight) return { status: "error", error: "file_unavailable" };
    inFlight = true;
    try {
      return TerminalClipboardResultSchema.parse(await readTerminalClipboardFiles(options.clipboard, options.platform));
    } finally { inFlight = false; }
  });
}
