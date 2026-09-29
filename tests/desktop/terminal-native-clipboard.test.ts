import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTerminalClipboardFiles, registerTerminalClipboardIpc } from "../../desktop/src/main/files/terminal-clipboard";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "matrix-native-clipboard-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
function clipboardFor(paths: string[]) {
  const buffer = Buffer.from(`<?xml version="1.0"?><plist version="1.0"><array>${paths.map((path) => `<string>${escapeXml(path)}</string>`).join("")}</array></plist>`);
  return { availableFormats: () => ["NSFilenamesPboardType", "text/plain"], readBuffer: vi.fn(() => buffer) };
}

describe.runIf(process.platform === "darwin")("native Terminal file clipboard", () => {
  it("reads all copied Finder files as original bytes, without returning local paths", async () => {
    const jpg = join(directory, "IMG_0330.JPG");
    const notes = join(directory, "说明 & notes.txt");
    await writeFile(jpg, Buffer.from([255, 216, 255, 0]));
    await writeFile(notes, "Unicode λ");
    const result = await readTerminalClipboardFiles(clipboardFor([jpg, notes]), "darwin");
    expect(result).toEqual({ status: "files", files: [
      { name: "IMG_0330.JPG", mimeType: "application/octet-stream", dataBase64: Buffer.from([255, 216, 255, 0]).toString("base64") },
      { name: "说明 & notes.txt", mimeType: "application/octet-stream", dataBase64: Buffer.from("Unicode λ").toString("base64") },
    ] });
    expect(JSON.stringify(result)).not.toContain(directory);
  });

  it("accepts binary Finder property lists and file URLs", async () => {
    const file = join(directory, "empty.txt");
    await writeFile(file, "");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const plist = join(directory, "paths.plist");
    await writeFile(plist, clipboardFor([file]).readBuffer());
    await promisify(execFile)("/usr/bin/plutil", ["-convert", "binary1", plist]);
    const { readFile } = await import("node:fs/promises");
    const binary = await readFile(plist);
    const result = await readTerminalClipboardFiles({ availableFormats: () => ["NSFilenamesPboardType"], readBuffer: () => binary }, "darwin");
    expect(result).toMatchObject({ status: "files", files: [{ name: "empty.txt", dataBase64: "" }] });
    const url = Buffer.from(new URL(`file://${file}`).href);
    expect(await readTerminalClipboardFiles({ availableFormats: () => ["public.file-url"], readBuffer: (format) => format === "public.file-url" ? url : Buffer.alloc(0) }, "darwin"))
      .toMatchObject({ status: "files", files: [{ name: "empty.txt" }] });
  });

  it("leaves text and screenshot clipboards to the existing paste path", async () => {
    const clipboard = { availableFormats: () => ["text/plain", "image/png"], readBuffer: vi.fn() };
    expect(await readTerminalClipboardFiles(clipboard, "darwin")).toEqual({ status: "empty" });
    expect(clipboard.readBuffer).not.toHaveBeenCalled();
  });

  it("reads native file metadata when Electron advertises only text/uri-list", async () => {
    const path = join(directory, "copied.txt");
    await writeFile(path, "actual file");
    const clipboard = clipboardFor([path]);
    clipboard.availableFormats = () => ["text/plain", "text/uri-list"];
    expect(await readTerminalClipboardFiles(clipboard, "darwin"))
      .toMatchObject({ status: "files", files: [{ name: "copied.txt" }] });
  });

  it("rejects more than eight files before opening any file", async () => {
    expect(await readTerminalClipboardFiles(clipboardFor(Array.from({ length: 9 }, (_, i) => join(directory, `${i}.txt`))), "darwin"))
      .toEqual({ status: "error", error: "too_many_files" });
  });

  it("rejects directories, symlinks, missing files and oversized files safely", async () => {
    const target = join(directory, "target.txt");
    const link = join(directory, "link.txt");
    const folder = join(directory, "folder");
    const big = join(directory, "big.bin");
    await writeFile(target, "safe");
    await symlink(target, link);
    await mkdir(folder);
    await writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    for (const path of [link, folder, join(directory, "missing.txt")]) {
      expect(await readTerminalClipboardFiles(clipboardFor([path]), "darwin")).toEqual({ status: "error", error: "file_unavailable" });
    }
    expect(await readTerminalClipboardFiles(clipboardFor([big]), "darwin"))
      .toEqual({ status: "error", error: "too_large" });
  });

  it("returns an error for malformed file metadata instead of falling back to a name", async () => {
    expect(await readTerminalClipboardFiles({ availableFormats: () => ["NSFilenamesPboardType"], readBuffer: () => Buffer.from("not plist") }, "darwin"))
      .toEqual({ status: "error", error: "file_unavailable" });
  });

  it("validates empty IPC requests and rejects an untrusted sender before reading the clipboard", async () => {
    const clipboard = clipboardFor([join(directory, "secret.txt")]);
    let listener: (event: unknown, payload: unknown) => Promise<unknown>;
    registerTerminalClipboardIpc({ handle: (_channel, fn) => { listener = fn; } }, {
      clipboard, platform: "darwin", isTrustedSender: () => false,
    });
    await expect(listener!({}, {})).rejects.toThrow("invalid request");
    expect(clipboard.readBuffer).not.toHaveBeenCalled();
    await expect(listener!({}, { path: "/tmp/secret" })).rejects.toThrow("invalid request");
  });
});
