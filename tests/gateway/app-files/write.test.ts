import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_FILE_MAX_BYTES, AppFileReadReplySchema, AppFileWriteReplySchema, appFileVersion, encodeAppFileBase64,
} from "../../../packages/contracts/src/app-files";
import * as appFileIo from "../../../packages/gateway/src/app-files/io";
import { createHarness, errorCode, type AppFileHarness } from "./helpers";

let harness: AppFileHarness | null = null;
afterEach(async () => { vi.restoreAllMocks(); await harness?.cleanup(); harness = null; });

const DOCX_FIXTURE = join(__dirname, "../../office/fixtures/basic.docx");
const b64 = (text: string) => encodeAppFileBase64(new TextEncoder().encode(text));
async function versionOf(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return appFileVersion(info.size, info.mtimeNs);
}

describe("files.write", () => {
  it("creates a new file with ifVersion null and replies with its version", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "Documents"));
    const original = await readFile(DOCX_FIXTURE);
    const response = await harness.post({ kind: "files.write", path: "Documents/new.docx", contentBase64: encodeAppFileBase64(original), ifVersion: null });
    expect(response.status).toBe(200);
    const reply = AppFileWriteReplySchema.parse(await response.json());
    const target = join(harness.home, "Documents/new.docx");
    expect((await readFile(target)).equals(original)).toBe(true);
    expect(reply).toMatchObject({ path: "Documents/new.docx", size: original.length, version: await versionOf(target) });
    const read = AppFileReadReplySchema.parse(await (await harness.post({ kind: "files.read", path: "Documents/new.docx" })).json());
    expect(read.version).toBe(reply.version);
    expect(await readdir(join(harness.home, "Documents"))).toEqual(["new.docx"]);
  });

  it("refuses ifVersion null when the file exists", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "a.txt"), "keep");
    const response = await harness.post({ kind: "files.write", path: "a.txt", contentBase64: b64("lost"), ifVersion: null });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("version_conflict");
    expect(await readFile(join(harness.home, "a.txt"), "utf8")).toBe("keep");
  });

  it("publishes a must-not-exist write with an exclusive link so a racing create wins", async () => {
    harness = await createHarness();
    const target = join(harness.home, "race.txt");
    const original = appFileIo.appFileIo.link;
    vi.spyOn(appFileIo.appFileIo, "link").mockImplementation(async (from, to) => {
      await writeFile(target, "other writer");
      return original(from, to);
    });
    const response = await harness.post({ kind: "files.write", path: "race.txt", contentBase64: b64("mine"), ifVersion: null });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("version_conflict");
    expect(await readFile(target, "utf8")).toBe("other writer");
    expect(await readdir(harness.home)).not.toContain(expect.stringMatching(/\.tmp$/));
    expect((await readdir(harness.home)).filter((name) => name.includes("matrix-app-file"))).toEqual([]);
  });

  it("refuses to publish over a copy another writer saved while the temp file was written", async () => {
    harness = await createHarness();
    const target = join(harness.home, "synced.docx");
    await writeFile(target, "base");
    const base = await versionOf(target);
    const original = appFileIo.appFileIo.writeTemp;
    // The sync daemon publishes a newer copy while this write fills and syncs its temp file.
    vi.spyOn(appFileIo.appFileIo, "writeTemp").mockImplementation(async (...args) => {
      await original(...args);
      await writeFile(target, "newer copy from sync");
    });
    const rename = vi.spyOn(appFileIo.appFileIo, "rename");
    const response = await harness.post({ kind: "files.write", path: "synced.docx", contentBase64: b64("mine"), ifVersion: base });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("version_conflict");
    expect(rename).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("newer copy from sync");
    expect((await readdir(harness.home)).filter((name) => name.includes("matrix-app-file"))).toEqual([]);
  });

  it("replaces a file when ifVersion matches, keeping its mode", async () => {
    harness = await createHarness();
    const target = join(harness.home, "sheet.xlsx");
    await writeFile(target, "old");
    await chmod(target, 0o640);
    const response = await harness.post({ kind: "files.write", path: "sheet.xlsx", contentBase64: b64("new content"), ifVersion: await versionOf(target) });
    expect(response.status).toBe(200);
    const reply = AppFileWriteReplySchema.parse(await response.json());
    expect(await readFile(target, "utf8")).toBe("new content");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(reply.version).toBe(await versionOf(target));
    expect(reply.size).toBe(11);
  });

  it("refuses a stale ifVersion and leaves the file untouched", async () => {
    harness = await createHarness();
    const target = join(harness.home, "doc.docx");
    await writeFile(target, "v1");
    const stale = await versionOf(target);
    await writeFile(target, "v2-longer");
    const response = await harness.post({ kind: "files.write", path: "doc.docx", contentBase64: b64("mine"), ifVersion: stale });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("version_conflict");
    expect(await readFile(target, "utf8")).toBe("v2-longer");
  });

  it("refuses a version for a file that no longer exists", async () => {
    harness = await createHarness();
    const response = await harness.post({ kind: "files.write", path: "gone.txt", contentBase64: b64("x"), ifVersion: "v1.1.1" });
    expect(response.status).toBe(409);
  });

  it("serialises two writers with the same base version so exactly one wins", async () => {
    harness = await createHarness();
    const target = join(harness.home, "shared.txt");
    await writeFile(target, "base");
    const base = await versionOf(target);
    const [first, second] = await Promise.all([
      harness.post({ kind: "files.write", path: "shared.txt", contentBase64: b64("first writer"), ifVersion: base }),
      harness.post({ kind: "files.write", path: "shared.txt", contentBase64: b64("second writer!"), ifVersion: base }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it("creates parents only when asked", async () => {
    harness = await createHarness();
    const missing = await harness.post({ kind: "files.write", path: "a/b/c.txt", contentBase64: b64("x"), ifVersion: null });
    expect(missing.status).toBe(404);
    const created = await harness.post({ kind: "files.write", path: "a/b/c.txt", contentBase64: b64("x"), ifVersion: null, createParents: true });
    expect(created.status).toBe(200);
    expect(await readFile(join(harness.home, "a/b/c.txt"), "utf8")).toBe("x");
  });

  it("refuses to write over a directory", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "folder"));
    const response = await harness.post({ kind: "files.write", path: "folder", contentBase64: b64("x"), ifVersion: null });
    expect(response.status).toBe(400);
    const replace = await harness.post({ kind: "files.write", path: "folder", contentBase64: b64("x"), ifVersion: "v1.0.0" });
    expect(replace.status).toBe(400);
    expect(await errorCode(replace)).toBe("invalid_request");
  });

  it("refuses content above the cap with too_large", async () => {
    harness = await createHarness();
    const content = encodeAppFileBase64(new Uint8Array(APP_FILE_MAX_BYTES + 3));
    const response = await harness.post({ kind: "files.write", path: "big.bin", contentBase64: content, ifVersion: null });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("too_large");
  });

  it("writes a file of exactly the cap", async () => {
    harness = await createHarness();
    const content = encodeAppFileBase64(new Uint8Array(APP_FILE_MAX_BYTES).fill(7));
    const response = await harness.post({ kind: "files.write", path: "max.bin", contentBase64: content, ifVersion: null });
    expect(response.status).toBe(200);
    expect((await stat(join(harness.home, "max.bin"))).size).toBe(APP_FILE_MAX_BYTES);
  });

  it("removes the temp file and keeps the original when the rename fails", async () => {
    harness = await createHarness();
    const target = join(harness.home, "keep.docx");
    await writeFile(target, "original");
    const failure = Object.assign(new Error("disk failed /secret/path"), { code: "EIO" });
    vi.spyOn(appFileIo.appFileIo, "rename").mockRejectedValue(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await harness.post({ kind: "files.write", path: "keep.docx", contentBase64: b64("replacement"), ifVersion: await versionOf(target) });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "unavailable", message: "File access is unavailable" } });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(warn).toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readdir(harness.home)).toEqual(expect.not.arrayContaining([expect.stringContaining("matrix-app-file")]));
    expect((await readdir(harness.home)).sort()).toEqual(["apps", "keep.docx", "system"]);
  });
});

describe("files.mkdir", () => {
  it("creates nested directories and is idempotent", async () => {
    harness = await createHarness();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await harness.post({ kind: "files.mkdir", path: "Projects/2026/Q4" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ path: "Projects/2026/Q4" });
    }
    expect((await stat(join(harness.home, "Projects/2026/Q4"))).isDirectory()).toBe(true);
  });

  it("refuses to turn a file into a directory", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "a.txt"), "a");
    const response = await harness.post({ kind: "files.mkdir", path: "a.txt" });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_request");
  });
});
