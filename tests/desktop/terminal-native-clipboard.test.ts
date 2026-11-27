import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTerminalClipboardFiles, registerTerminalClipboardIpc } from "../../desktop/src/main/files/terminal-clipboard";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "matrix-native-clipboard-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

// Electron 44+ clipboard shape: async has()/read() with W3C-style ClipboardItems.
// On macOS, text/uri-list is Electron's mapping of Finder's native file list.
function clipboardWithUriList(uriList: string | null, extraTypes: string[] = ["text/plain"]) {
  const types = uriList === null ? extraTypes : ["text/uri-list", ...extraTypes];
  const getType = vi.fn(async (type: string) => {
    if (type !== "text/uri-list" || uriList === null) throw new DOMException("missing", "NotFoundError");
    return new Blob([uriList]);
  });
  return {
    has: vi.fn(async (mime: string) => types.includes(mime)),
    read: vi.fn(async () => [{ types, getType }]),
  };
}
const uriListFor = (paths: string[]) => paths.map((path) => pathToFileURL(path).href).join("\r\n");
const FINDER_LIST = 'electron application/osclipboard;format="NSFilenamesPboardType"';
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const finderPlist = (paths: string[]) =>
  `<?xml version="1.0"?><plist version="1.0"><array>${paths.map((path) => `<string>${escapeXml(path)}</string>`).join("")}</array></plist>`;
// Electron 45 on macOS: a multi-file Finder copy exposes only the first file as
// text/uri-list; the raw NSFilenamesPboardType property list carries every file.
function finderClipboard(paths: string[], rawList: Blob | null = new Blob([finderPlist(paths)])) {
  const types = ["text/uri-list", ...(rawList ? [FINDER_LIST] : []), "text/plain"];
  const getType = vi.fn(async (type: string) => {
    if (type === "text/uri-list") return new Blob([pathToFileURL(paths[0]!).href]);
    if (type === FINDER_LIST && rawList) return rawList;
    throw new DOMException("missing", "NotFoundError");
  });
  return { has: vi.fn(async (mime: string) => types.includes(mime)), read: vi.fn(async () => [{ types, getType }]), getType };
}
const parseXmlPlist = async (bytes: Uint8Array) =>
  [...new TextDecoder().decode(bytes).matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!.replaceAll("&lt;", "<").replaceAll("&amp;", "&"));

describe.runIf(process.platform !== "win32")("native Terminal file clipboard", () => {
  it("reads all copied Finder files as original bytes, without returning local paths", async () => {
    const jpg = join(directory, "IMG_0330.JPG");
    const notes = join(directory, "说明 & notes.txt");
    await writeFile(jpg, Buffer.from([255, 216, 255, 0]));
    await writeFile(notes, "Unicode λ");
    const result = await readTerminalClipboardFiles(clipboardWithUriList(uriListFor([jpg, notes])), "darwin");
    expect(result).toEqual({ status: "files", files: [
      { name: "IMG_0330.JPG", mimeType: "application/octet-stream", dataBase64: Buffer.from([255, 216, 255, 0]).toString("base64") },
      { name: "说明 & notes.txt", mimeType: "application/octet-stream", dataBase64: Buffer.from("Unicode λ").toString("base64") },
    ] });
    expect(JSON.stringify(result)).not.toContain(directory);
  });

  it("pastes every file of a multi-file Finder copy from the native file list, not just the first URI", async () => {
    const one = join(directory, "one.txt");
    const two = join(directory, "two words.txt");
    await writeFile(one, "first");
    await writeFile(two, "second");
    const clipboard = finderClipboard([one, two]);
    expect(await readTerminalClipboardFiles(clipboard, "darwin", parseXmlPlist)).toMatchObject({ status: "files", files: [
      { name: "one.txt", dataBase64: Buffer.from("first").toString("base64") },
      { name: "two words.txt", dataBase64: Buffer.from("second").toString("base64") },
    ] });
    expect(clipboard.getType).not.toHaveBeenCalledWith("text/uri-list");
  });

  it("rejects an oversized native file list before parsing it", async () => {
    const parse = vi.fn(parseXmlPlist);
    const clipboard = finderClipboard([join(directory, "a.txt")], new Blob([Buffer.alloc(64 * 1024 + 1, 0x61)]));
    expect(await readTerminalClipboardFiles(clipboard, "darwin", parse)).toEqual({ status: "error", error: "file_unavailable" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("returns an error for a malformed native file list instead of falling back to the first URI", async () => {
    const file = join(directory, "a.txt");
    await writeFile(file, "a");
    for (const parsed of [{ not: "an array" }, [], ["relative/path.txt"], [`${file}\nsecond`], [42]]) {
      expect(await readTerminalClipboardFiles(finderClipboard([file]), "darwin", async () => parsed))
        .toEqual({ status: "error", error: "file_unavailable" });
    }
  });

  it("caps the native file list at eight files before opening any file", async () => {
    const paths = Array.from({ length: 9 }, (_, i) => join(directory, `${i}.txt`));
    expect(await readTerminalClipboardFiles(finderClipboard(paths), "darwin", parseXmlPlist))
      .toEqual({ status: "error", error: "too_many_files" });
  });

  it.runIf(process.platform === "darwin")("parses XML and binary Finder property lists with plutil", async () => {
    const one = join(directory, "one.txt");
    const two = join(directory, "说明 & notes.txt");
    await writeFile(one, "first");
    await writeFile(two, "Unicode λ");
    expect(await readTerminalClipboardFiles(finderClipboard([one, two]), "darwin"))
      .toMatchObject({ status: "files", files: [{ name: "one.txt" }, { name: "说明 & notes.txt" }] });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { readFile } = await import("node:fs/promises");
    const plist = join(directory, "paths.plist");
    await writeFile(plist, finderPlist([one, two]));
    await promisify(execFile)("/usr/bin/plutil", ["-convert", "binary1", plist]);
    expect(await readTerminalClipboardFiles(finderClipboard([one, two], new Blob([await readFile(plist)])), "darwin"))
      .toMatchObject({ status: "files", files: [{ name: "one.txt" }, { name: "说明 & notes.txt" }] });
    expect(await readTerminalClipboardFiles(finderClipboard([one], new Blob(["not plist"])), "darwin"))
      .toEqual({ status: "error", error: "file_unavailable" });
  });

  it("accepts a single file URI, LF separators, RFC 2483 comments and a trailing newline", async () => {
    const file = join(directory, "empty.txt");
    await writeFile(file, "");
    const list = `# copied by Finder\n${pathToFileURL(file).href}\n`;
    expect(await readTerminalClipboardFiles(clipboardWithUriList(list), "darwin"))
      .toEqual({ status: "files", files: [{ name: "empty.txt", mimeType: "application/octet-stream", dataBase64: "" }] });
  });

  it("leaves text and screenshot clipboards to the existing paste path", async () => {
    const clipboard = clipboardWithUriList(null, ["text/plain", "image/png"]);
    expect(await readTerminalClipboardFiles(clipboard, "darwin")).toEqual({ status: "empty" });
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it("leaves non-macOS clipboards to the existing paste path without reading them", async () => {
    const clipboard = clipboardWithUriList(uriListFor([join(directory, "a.txt")]));
    expect(await readTerminalClipboardFiles(clipboard, "linux")).toEqual({ status: "empty" });
    expect(clipboard.has).not.toHaveBeenCalled();
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it("leaves a URI list without any file URI to text paste", async () => {
    expect(await readTerminalClipboardFiles(clipboardWithUriList("https://example.org/page\r\n"), "darwin"))
      .toEqual({ status: "empty" });
    expect(await readTerminalClipboardFiles(clipboardWithUriList(""), "darwin"))
      .toEqual({ status: "empty" });
  });

  it("rejects a mixed file and non-file URI list instead of uploading a partial batch", async () => {
    const file = join(directory, "a.txt");
    await writeFile(file, "a");
    expect(await readTerminalClipboardFiles(clipboardWithUriList(`${pathToFileURL(file).href}\r\nhttps://example.org/`), "darwin"))
      .toEqual({ status: "error", error: "file_unavailable" });
  });

  it("rejects more than eight files before opening any file", async () => {
    expect(await readTerminalClipboardFiles(clipboardWithUriList(uriListFor(Array.from({ length: 9 }, (_, i) => join(directory, `${i}.txt`)))), "darwin"))
      .toEqual({ status: "error", error: "too_many_files" });
  });

  it("rejects oversized file metadata before reading it", async () => {
    const clipboard = clipboardWithUriList(null);
    const blob = new Blob([Buffer.alloc(64 * 1024 + 1, 0x61)]);
    const text = vi.spyOn(blob, "text");
    clipboard.has.mockResolvedValue(true);
    clipboard.read.mockResolvedValue([{ types: ["text/uri-list"], getType: vi.fn(async () => blob) }]);
    expect(await readTerminalClipboardFiles(clipboard, "darwin")).toEqual({ status: "error", error: "file_unavailable" });
    expect(text).not.toHaveBeenCalled();
  });

  it("returns an error when the advertised file list cannot be read", async () => {
    const clipboard = clipboardWithUriList(null);
    clipboard.has.mockResolvedValue(true);
    expect(await readTerminalClipboardFiles(clipboard, "darwin")).toEqual({ status: "error", error: "file_unavailable" });
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
      expect(await readTerminalClipboardFiles(clipboardWithUriList(uriListFor([path])), "darwin")).toEqual({ status: "error", error: "file_unavailable" });
    }
    expect(await readTerminalClipboardFiles(clipboardWithUriList(uriListFor([big])), "darwin"))
      .toEqual({ status: "error", error: "too_large" });
  });

  it("returns an error for malformed or remote file URIs instead of falling back to a name", async () => {
    for (const list of ["file://remote-host/etc/hosts", "file:///tmp/%00evil", "file:"]) {
      expect(await readTerminalClipboardFiles(clipboardWithUriList(list), "darwin"))
        .toEqual({ status: "error", error: "file_unavailable" });
    }
  });

  it("validates empty IPC requests and rejects an untrusted sender before reading the clipboard", async () => {
    const clipboard = clipboardWithUriList(uriListFor([join(directory, "secret.txt")]));
    let listener: (event: unknown, payload: unknown) => Promise<unknown>;
    registerTerminalClipboardIpc({ handle: (_channel, fn) => { listener = fn; } }, {
      clipboard, platform: "darwin", isTrustedSender: () => false,
    });
    await expect(listener!({}, {})).rejects.toThrow("invalid request");
    expect(clipboard.has).not.toHaveBeenCalled();
    expect(clipboard.read).not.toHaveBeenCalled();
    await expect(listener!({}, { path: "/tmp/secret" })).rejects.toThrow("invalid request");
  });

  it("refuses to register against a clipboard without the async read API", () => {
    expect(() => registerTerminalClipboardIpc({ handle: vi.fn() }, {
      clipboard: { availableFormats: () => [], readBuffer: () => Buffer.alloc(0) } as never,
      isTrustedSender: () => true,
    })).toThrow("clipboard service unavailable");
  });
});
