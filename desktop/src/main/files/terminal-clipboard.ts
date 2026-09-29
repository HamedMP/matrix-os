import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { INVOKE_CHANNELS } from "../../shared/ipc-contract";
import {
  TERMINAL_CLIPBOARD_MAX_BYTES, TERMINAL_CLIPBOARD_MAX_FILES,
  TerminalClipboardResultSchema, type TerminalClipboardResult,
} from "../../shared/terminal-clipboard";

interface FileClipboard {
  availableFormats(): string[];
  readBuffer(format: string): Buffer;
}
const MAX_METADATA_BYTES = 64 * 1024;

function finderPaths(buffer: Buffer): Promise<unknown> {
  // macOS's parser handles both XML and binary pasteboard property lists.
  // Input is passed over stdin, never as a command or filesystem argument.
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      timeout: 3_000, maxBuffer: MAX_METADATA_BYTES, encoding: "utf8",
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (parseError: unknown) { reject(parseError); }
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(buffer);
  });
}

export async function readTerminalClipboardFiles(
  clipboard: FileClipboard,
  platform: string = process.platform,
): Promise<TerminalClipboardResult> {
  // Finder file copy is the native format supported here. Other platforms
  // retain the existing text/image clipboard path and local file drag/drop.
  if (platform !== "darwin") return { status: "empty" };
  try {
    const formats = clipboard.availableFormats();
    if (!formats.some((format) => ["NSFilenamesPboardType", "public.file-url", "text/uri-list"].includes(format))) {
      return { status: "empty" };
    }
    // Electron advertises Finder's native formats as text/uri-list. Raw reads
    // still expose the original property list, including multi-file copies.
    const legacyMetadata = clipboard.readBuffer("NSFilenamesPboardType");
    const format = legacyMetadata.length > 0 ? "NSFilenamesPboardType" : "public.file-url";
    const metadata = format === "NSFilenamesPboardType" ? legacyMetadata : clipboard.readBuffer(format);
    if (metadata.length === 0 || metadata.length > MAX_METADATA_BYTES) {
      return { status: "error", error: "file_unavailable" };
    }
    const paths = format === "NSFilenamesPboardType"
      ? await finderPaths(metadata) : [fileURLToPath(metadata.toString("utf8").replace(/\0+$/, ""))];
    if (!Array.isArray(paths) || paths.length === 0) return { status: "error", error: "file_unavailable" };
    if (paths.length > TERMINAL_CLIPBOARD_MAX_FILES) return { status: "error", error: "too_many_files" };
    const files: Array<{ name: string; mimeType: "application/octet-stream"; dataBase64: string }> = [];
    for (const path of paths) {
      if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path)) {
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
  if (typeof options.clipboard?.readBuffer !== "function" || typeof options.isTrustedSender !== "function") {
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
