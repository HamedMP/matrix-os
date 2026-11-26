import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_FILE_MAX_BYTES, AppFileListReplySchema, AppFileReadReplySchema, AppFileStatReplySchema, appFileVersion, decodeAppFileBase64,
} from "../../../packages/contracts/src/app-files";
import { getMimeType } from "../../../packages/gateway/src/file-utils";
import { createHarness, errorCode, type AppFileHarness } from "./helpers";

let harness: AppFileHarness | null = null;
afterEach(async () => { await harness?.cleanup(); harness = null; });

const DOCX_FIXTURE = join(__dirname, "../../office/fixtures/basic.docx");

/** Makes a named pipe with the system `mkfifo`, or returns false where there is none. */
async function makeFifo(path: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  try { await promisify(execFile)("mkfifo", [path]); return true; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Opens the pipe's write end once, which releases a reader stuck in a blocking open. */
async function releaseFifoReaders(path: string): Promise<void> {
  try { await (await open(path, constants.O_WRONLY | constants.O_NONBLOCK)).close(); }
  catch (error: unknown) {
    // ENXIO: no reader is waiting, so nothing is stuck.
    if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
  }
}

function withinMs<T>(work: Promise<T>, ms: number): Promise<T | "timed out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed out">((done) => { timer = setTimeout(() => done("timed out"), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

describe("files.list", () => {
  it("lists directories first, then files by name, with sizes and ISO times", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "Documents/zeta"), { recursive: true });
    await mkdir(join(harness.home, "Documents/alpha"));
    await writeFile(join(harness.home, "Documents/b.docx"), "bb");
    await writeFile(join(harness.home, "Documents/a.xlsx"), "a");
    const when = new Date("2026-05-01T10:00:00.000Z");
    await utimes(join(harness.home, "Documents/a.xlsx"), when, when);
    const response = await harness.post({ kind: "files.list", dir: "Documents" });
    expect(response.status).toBe(200);
    const reply = AppFileListReplySchema.parse(await response.json());
    expect(reply.truncated).toBe(false);
    expect(reply.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["alpha", "dir"], ["zeta", "dir"], ["a.xlsx", "file"], ["b.docx", "file"],
    ]);
    expect(reply.entries[2]).toEqual({ name: "a.xlsx", path: "Documents/a.xlsx", kind: "file", size: 1, modifiedAt: when.toISOString() });
    expect(reply.entries[0]).toMatchObject({ path: "Documents/alpha", size: 0 });
  });

  it("bounds the listing by limit and reports truncation", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "many"));
    await Promise.all(Array.from({ length: 30 }, (_, index) => writeFile(join(harness!.home, "many", `f${String(index).padStart(2, "0")}.txt`), "x")));
    const reply = AppFileListReplySchema.parse(await (await harness.post({ kind: "files.list", dir: "many", limit: 10 })).json());
    expect(reply.entries).toHaveLength(10);
    expect(reply.entries[0]?.name).toBe("f00.txt");
    expect(reply.truncated).toBe(true);
    const full = AppFileListReplySchema.parse(await (await harness.post({ kind: "files.list", dir: "many" })).json());
    expect(full.entries).toHaveLength(30);
    expect(full.truncated).toBe(false);
  });

  it("refuses to list a file", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "a.txt"), "a");
    const response = await harness.post({ kind: "files.list", dir: "a.txt" });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_request");
  });
});

describe("files.stat and files.read", () => {
  it("round-trips a real .docx byte for byte with its OOXML type", async () => {
    harness = await createHarness();
    const original = await readFile(DOCX_FIXTURE);
    await mkdir(join(harness.home, "Documents"));
    await writeFile(join(harness.home, "Documents/basic.docx"), original);
    const statReply = AppFileStatReplySchema.parse(await (await harness.post({ kind: "files.stat", path: "Documents/basic.docx" })).json());
    const info = await stat(join(harness.home, "Documents/basic.docx"), { bigint: true });
    expect(statReply).toEqual({
      path: "Documents/basic.docx", size: original.length,
      modifiedAt: new Date(Number(info.mtimeMs)).toISOString(), version: appFileVersion(info.size, info.mtimeNs),
    });
    const readResponse = await harness.post({ kind: "files.read", path: "Documents/basic.docx" });
    expect(readResponse.status).toBe(200);
    const reply = AppFileReadReplySchema.parse(await readResponse.json());
    expect(reply.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(reply.version).toBe(statReply.version);
    expect(Buffer.from(decodeAppFileBase64(reply.contentBase64)).equals(original)).toBe(true);
  });

  it("reads arbitrary binary content intact", async () => {
    harness = await createHarness();
    const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
    await writeFile(join(harness.home, "blob.bin"), binary);
    const reply = AppFileReadReplySchema.parse(await (await harness.post({ kind: "files.read", path: "blob.bin" })).json());
    expect(reply.mimeType).toBe("application/octet-stream");
    expect(Buffer.from(decodeAppFileBase64(reply.contentBase64)).equals(binary)).toBe(true);
  });

  it("refuses to read a file above the cap but still stats its true size", async () => {
    harness = await createHarness();
    const path = join(harness.home, "huge.xlsx");
    await writeFile(path, "");
    await truncate(path, APP_FILE_MAX_BYTES + 1);
    const read = await harness.post({ kind: "files.read", path: "huge.xlsx" });
    expect(read.status).toBe(413);
    expect(await errorCode(read)).toBe("too_large");
    const info = AppFileStatReplySchema.parse(await (await harness.post({ kind: "files.stat", path: "huge.xlsx" })).json());
    expect(info.size).toBe(APP_FILE_MAX_BYTES + 1);
  });

  it("reads a file of exactly the cap", async () => {
    harness = await createHarness();
    const path = join(harness.home, "max.bin");
    await writeFile(path, "");
    await truncate(path, APP_FILE_MAX_BYTES);
    const reply = AppFileReadReplySchema.parse(await (await harness.post({ kind: "files.read", path: "max.bin" })).json());
    expect(reply.size).toBe(APP_FILE_MAX_BYTES);
  });

  it("refuses directories for stat and read", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "folder"));
    for (const kind of ["files.stat", "files.read"]) {
      const response = await harness.post({ kind, path: "folder" });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_request");
    }
  });
});

describe("named pipes", () => {
  it("answers read, stat and write on a named pipe promptly with invalid_request instead of waiting for a writer", async (context) => {
    harness = await createHarness();
    const fifo = join(harness.home, "pipe.docx");
    if (!await makeFifo(fifo)) { context.skip(); return; }
    try {
      for (const input of [
        { kind: "files.read", path: "pipe.docx" },
        { kind: "files.stat", path: "pipe.docx" },
        { kind: "files.write", path: "pipe.docx", contentBase64: "", ifVersion: null },
      ]) {
        const response = await withinMs(harness.post(input), 2_000);
        expect(response, input.kind).not.toBe("timed out");
        if (response === "timed out") continue;
        expect(response.status, input.kind).toBe(400);
        expect(await errorCode(response), input.kind).toBe("invalid_request");
      }
      const listing = AppFileListReplySchema.parse(await (await harness.post({ kind: "files.list", dir: "" })).json());
      expect(listing.entries.map((entry) => entry.name)).not.toContain("pipe.docx");
    } finally {
      await releaseFifoReaders(fifo);
    }
  });
});

describe("MIME types", () => {
  it.each([
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["csv", "text/csv"],
  ])("maps .%s", async (ext, mime) => {
    expect(getMimeType(`.${ext}`)).toBe(mime);
    expect(getMimeType(ext.toUpperCase())).toBe(mime);
  });
});
