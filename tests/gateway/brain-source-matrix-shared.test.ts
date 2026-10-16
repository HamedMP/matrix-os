import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixFilesAdapter } from "../../packages/gateway/src/brain/sources/matrix/files.js";
import {
  fileStillPresent, readTextFile, walkFiles, type WalkBudget,
} from "../../packages/gateway/src/brain/sources/matrix/files-walk.js";
import { loadMatrixConfig, saveMatrixConfig } from "../../packages/gateway/src/brain/sources/matrix/database.js";
import {
  bootstrapBrainMatrixDatabase, createBrainMatrixFilesHandler,
} from "../../packages/gateway/src/brain/sources/matrix/index.js";
import {
  cutUtf8, decodeMatrixCursor, documentTitle, encodeMatrixCursor, guardRead, isoInstant, matrixDocumentId, resumeIndex,
} from "../../packages/gateway/src/brain/sources/matrix/shared.js";
import { parseChatConfig } from "../../packages/gateway/src/brain/sources/matrix/config.js";
import { BRAIN_MATRIX_LIMITS } from "../../packages/gateway/src/brain/sources/matrix/types.js";
import { BrainFeatureError } from "../../packages/gateway/src/brain/contracts.js";
import { z } from "zod/v4";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { createMatrixSource, liveTitles, matrixScope, runMatrixLoop } from "./helpers/brain-source-matrix-loop.js";

interface FakeListing { readonly entries: readonly { name: string; kind: "file" | "directory" }[]; read: number }
const faults = vi.hoisted(() => ({
  realpath: new Map<string, Error | string>(),
  lstat: new Map<string, Error | "other-inode">(),
  afterOpen: null as (() => void) | null,
  listings: new Map<string, FakeListing>(),
  /** Bytes the next opened file's first read returns at most. */
  shortRead: null as number | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: string) => {
      const fault = faults.realpath.get(String(path));
      if (fault instanceof Error) throw fault;
      return fault ?? actual.realpath(path);
    },
    lstat: async (path: string) => {
      const fault = faults.lstat.get(String(path));
      if (fault instanceof Error) throw fault;
      const stats = await actual.lstat(path);
      return fault === "other-inode" ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: stats.ino + 1 }) : stats;
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const listing = faults.listings.get(String(args[0]));
      if (listing === undefined) return actual.opendir(...args);
      return (async function* () {
        for (const { name, kind } of listing.entries) {
          listing.read += 1;
          yield { name, isFile: () => kind === "file", isDirectory: () => kind === "directory" };
        }
      })();
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const short = faults.shortRead;
      faults.shortRead = null;
      if (short !== null) {
        const read = handle.read.bind(handle) as (b: Buffer, o: number, l: number, p: number) => ReturnType<typeof handle.read>;
        let first = true;
        Object.assign(handle, {
          read: (buffer: Buffer, offset: number, length: number, position: number) => {
            const cap = first ? Math.min(length, short) : length;
            first = false;
            return read(buffer, offset, cap, position);
          },
        });
      }
      const hook = faults.afterOpen;
      faults.afterOpen = null;
      hook?.();
      return handle;
    },
  };
});

const io = () => Object.assign(new Error("io"), { code: "EIO" });
const gone = () => Object.assign(new Error("gone"), { code: "ENOENT" });
let home: string;
let harness: BrainHarness;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "brain-matrix-shared-")));
  harness = await createBrainHarness();
  await bootstrapBrainMatrixDatabase(harness.db);
});
afterEach(async () => {
  faults.afterOpen = null;
  faults.realpath.clear();
  faults.lstat.clear();
  faults.listings.clear();
  faults.shortRead = null;
  rmSync(home, { recursive: true, force: true });
  await harness.destroy();
});

describe("matrix sources shared pieces", () => {
  it("bootstraps idempotently, keeps one config per source and drops it with the scope", async () => {
    await bootstrapBrainMatrixDatabase(harness.db);
    const sourceId = await createMatrixSource(harness, "matrix_notes", "matrix_notes");
    await saveMatrixConfig(harness.db, "matrix_notes", matrixScope, sourceId, { folders: ["a"] }, harness.now());
    await saveMatrixConfig(harness.db, "matrix_chat", matrixScope, sourceId, { chatIds: ["chat_a"] }, harness.now());
    expect(await loadMatrixConfig(harness.db, "matrix_notes", matrixScope, sourceId)).toEqual({ folders: ["a"] });
    expect(await loadMatrixConfig(harness.db, "matrix_chat", matrixScope, sourceId)).toBeNull();
    await expect(saveMatrixConfig(harness.db, "matrix_notes", matrixScope, sourceId, { pad: "x".repeat(9_000) }, harness.now()))
      .rejects.toThrow();
    await harness.repository.eraseScope(matrixScope);
    const rows = await sql<{ count: number }>`SELECT count(*)::int AS count FROM brain_matrix_sources`.execute(harness.db);
    expect(rows.rows[0]!.count).toBe(0);
  });

  it("cuts text on character boundaries and parses times and cursors strictly", () => {
    expect(cutUtf8("a\u00e9", 2)).toBe("a");
    expect(cutUtf8("abc", 5)).toBe("abc");
    expect(documentTitle(`${"a".repeat(295)}\u{1F600}x`, "fallback", " - x")).toBe(`${"a".repeat(295)} - x`);
    expect(documentTitle("\u0000 ", "fallback")).toBe("fallback");
    expect(isoInstant(5)).toBeNull();
    expect(isoInstant(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01T00:00:00.000Z");
    const schema = z.object({ v: z.literal(1) }).strict();
    expect(decodeMatrixCursor("x1:", schema, "x1:eyJ2IjoxfQ")).toEqual({ v: 1 });
    expect(decodeMatrixCursor("x1:", schema, "x1:e30")).toBeNull();
    expect(decodeMatrixCursor("x1:", schema, "x1:bm90IGpzb24")).toBeNull();
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw new RangeError("too deep"); });
    expect(() => decodeMatrixCursor("x1:", schema, "x1:eyJ2IjoxfQ")).toThrow(RangeError);
    parse.mockRestore();
    expect(resumeIndex(["a", "c"], "b")).toBe(1);
    expect(resumeIndex(["a", "c"], "d")).toBe(2);
    expect(() => parseChatConfig({ chatIds: [1n] })).toThrow(BrainFeatureError);
    expect(() => parseChatConfig(undefined)).toThrow(BrainFeatureError);
  });

  it("passes unexpected errors through to the runner", async () => {
    await expect(guardRead(async () => { throw new TypeError("bug"); })).rejects.toThrow(TypeError);
  });

  it("refuses file system failures that are not a missing entry", async () => {
    mkdirSync(join(home, "docs/sub"), { recursive: true });
    writeFileSync(join(home, "docs/a.md"), "a");
    writeFileSync(join(home, "docs/sub/b.md"), "b");
    const adapter = createMatrixFilesAdapter(home);
    const config = { roots: ["docs"], extensions: ["md"], maxFileBytes: 1_000 };
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:x");
    const run = () => runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config);

    faults.lstat.set(join(home, "docs/a.md"), gone());
    faults.realpath.set(join(home, "docs/sub"), join(home, "elsewhere"));
    expect(await run()).toMatchObject({ caughtUp: true, written: 0, skipped: 1 });
    faults.lstat.clear();
    faults.realpath.set(join(home, "docs/sub"), gone());
    expect(await run()).toMatchObject({ caughtUp: true, written: 1 });
    faults.realpath.clear();
    expect(await liveTitles(harness, sourceId)).toEqual(["docs/a.md"]);

    faults.lstat.set(join(home, "docs/a.md"), "other-inode");
    expect(await readTextFile(join(home, "docs/a.md"), 10)).toEqual({ kind: "gone" });
    faults.lstat.set(join(home, "docs/a.md"), io());
    await expect(readTextFile(join(home, "docs/a.md"), 10)).rejects.toThrow("io");
    faults.realpath.set(join(home, "docs"), io());
    await expect(fileStillPresent(home, "docs", "docs/a.md", 10, { left: 10, fits: new Map() })).rejects.toThrow("io");
    await expect(run()).rejects.toThrow("io");
    faults.realpath.clear();
    faults.lstat.clear();
    faults.realpath.set(join(home, "docs/sub"), io());
    await expect(run()).rejects.toThrow("io");

    // The folder picker passes file system failures that are not a missing entry through as well.
    faults.realpath.set(home, io());
    const handler = createBrainMatrixFilesHandler({ kysely: harness.db, homePath: home, ownerIds: ["owner_a"] });
    const project = { projectId: "proj_a", slug: "a", name: "A", scope: matrixScope };
    await expect(handler.listOptions!("owner_a", project, {}, new AbortController().signal)).rejects.toThrow("io");
  });

  it("counts skipped names against the entries read from one folder", async () => {
    mkdirSync(join(home, "docs"));
    writeFileSync(join(home, "docs/z.md"), "z");
    const max = BRAIN_MATRIX_LIMITS.dirEntriesMax;
    // Hidden names are skipped, but each one is still an entry read from the folder.
    const hidden = Array.from({ length: 2 * max }, (_, index) => ({ name: `.h${index}`, kind: "file" as const }));
    const listing: FakeListing = { entries: [...hidden, { name: "z.md", kind: "file" }], read: 0 };
    faults.listings.set(join(home, "docs"), listing);
    const truncated = vi.fn();
    const budget: WalkBudget = { entries: 10, reads: 100_000, pathBytes: 1_000, position: null, truncated, secretSkipped: vi.fn() };
    const found: string[] = [];
    for await (const entry of walkFiles(join(home, "docs"), [], null, budget)) found.push(entry.path);
    expect(found).toEqual([]);
    expect(truncated).toHaveBeenCalledTimes(1);
    expect(listing.read).toBe(max + 1);
  });

  it("counts every folder read against the page's read budget and resumes where the page stopped", async () => {
    const { dirEntriesMax: max, dirReadsPerPage, fileDepthMax } = BRAIN_MATRIX_LIMITS;
    // A page that resumes deep in a tree must still have room to move on after reading its way back.
    expect(dirReadsPerPage).toBeGreaterThan(fileDepthMax * max);
    // 20 folders of one file and max - 1 hidden names each: 100,000 entries, more than one page may read.
    const folders = Array.from({ length: 20 }, (_, index) => `d${String(index).padStart(2, "0")}`);
    const hidden = Array.from({ length: max - 1 }, (_, index) => ({ name: `.h${index}`, kind: "file" as const }));
    const listings = folders.map((folder) => {
      mkdirSync(join(home, "docs", folder), { recursive: true });
      writeFileSync(join(home, "docs", folder, "x.md"), folder);
      const listing: FakeListing = { entries: [...hidden, { name: "x.md", kind: "file" }], read: 0 };
      faults.listings.set(join(home, "docs", folder), listing);
      return listing;
    });
    const read = () => listings.reduce((sum, listing) => sum + listing.read, 0);
    const adapter = createMatrixFilesAdapter(home);
    const config = { roots: ["docs"], extensions: ["md"], maxFileBytes: 1_000 };
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:x");
    const first = await runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config, { maxPages: 1 });
    expect(first.caughtUp).toBe(false);
    expect(first.written).toBeGreaterThan(0);
    expect(first.written).toBeLessThan(folders.length);
    // The page stops before the next folder once the budget is spent, so it reads at most one folder past it.
    expect(read()).toBeLessThanOrEqual(dirReadsPerPage + max);
    const rest = await runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config);
    expect(rest).toMatchObject({ caughtUp: true, written: folders.length - first.written });
    expect(await liveTitles(harness, sourceId)).toEqual(folders.map((folder) => `docs/${folder}/x.md`));

    // The sweep reads the same folders to check their size, within the same budget per page.
    const cursor = (await harness.repository.getSyncCursor(matrixScope, sourceId))!.cursor;
    const sweep = encodeMatrixCursor("mf1:", { v: 1, phase: "sweep", after: null });
    await harness.repository.applySyncBatch(matrixScope, { sourceId, expectedCursor: cursor, nextCursor: sweep, upserts: [], deletions: [] });
    for (const listing of listings) listing.read = 0;
    const sweepPage = await runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config, { maxPages: 1 });
    expect(sweepPage).toMatchObject({ caughtUp: false, deleted: 0 });
    expect(read()).toBeLessThanOrEqual(dirReadsPerPage + max);
    expect(await runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config)).toMatchObject({ caughtUp: true, deleted: 0 });
  });

  it("shares one read budget across the roots of a page", async () => {
    const { dirEntriesMax: max, dirReadsPerPage } = BRAIN_MATRIX_LIMITS;
    // Two roots of 8 folders of max entries each: 80,000 entries, more than one page may read across both.
    const hidden = Array.from({ length: max - 1 }, (_, index) => ({ name: `.h${index}`, kind: "file" as const }));
    const paths = ["a", "b"].flatMap((root) => Array.from({ length: 8 }, (_, index) => `${root}/d${index}/x.md`));
    const listings = paths.map((path) => {
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), path);
      const listing: FakeListing = { entries: [...hidden, { name: "x.md", kind: "file" }], read: 0 };
      faults.listings.set(join(home, path, ".."), listing);
      return listing;
    });
    const read = () => listings.reduce((sum, listing) => sum + listing.read, 0);
    const adapter = createMatrixFilesAdapter(home);
    const config = { roots: ["a", "b"], extensions: ["md"], maxFileBytes: 1_000 };
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:x");
    const first = await runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config, { maxPages: 1 });
    // The second root starts with what the first one left, not a fresh budget.
    expect(first.written).toBeGreaterThan(8);
    expect(first.written).toBeLessThan(paths.length);
    expect(read()).toBeLessThanOrEqual(dirReadsPerPage + max);
    expect(await runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config)).toMatchObject({ caughtUp: true });
    expect(await liveTitles(harness, sourceId)).toEqual(paths);
  });

  it("stops a sweep page between the folder checks of a deep file and checks it again on the next page", async () => {
    const { dirEntriesMax: max, dirReadsPerPage, fileDepthMax } = BRAIN_MATRIX_LIMITS;
    // A whole page has room for the folder checks of one file, so the first file of a page always gets an answer.
    expect(dirReadsPerPage).toBeGreaterThan(fileDepthMax * (max + 1));
    const folders = Array.from({ length: fileDepthMax - 1 }, (_, index) => `d${index}`);
    const deep = `docs/${folders.join("/")}/x.md`;
    // 12 shallow files the sweep checks before the deep one (documents come in id order): 60,000 of the page's reads.
    const id = (path: string) => matrixDocumentId("matrix_files", "matrix_files:x", [path]);
    const shallow = Array.from({ length: 100 }, (_, index) => `w${index}`)
      .filter((name) => id(`docs/${name}/x.md`) < id(deep));
    const hidden = Array.from({ length: max - 1 }, (_, index) => ({ name: `.h${index}`, kind: "file" as const }));
    const listings: FakeListing[] = [];
    const fill = (folder: string, last: { name: string; kind: "file" | "directory" }) => {
      listings.push({ entries: [...hidden, last], read: 0 });
      faults.listings.set(join(home, folder), listings[listings.length - 1]!);
    };
    mkdirSync(join(home, deep, ".."), { recursive: true });
    writeFileSync(join(home, deep), "deep");
    folders.forEach((_, index) => fill(`docs/${folders.slice(0, index + 1).join("/")}`,
      index + 1 < folders.length ? { name: folders[index + 1]!, kind: "directory" } : { name: "x.md", kind: "file" }));
    for (const name of shallow.slice(0, 12)) {
      mkdirSync(join(home, "docs", name));
      writeFileSync(join(home, "docs", name, "x.md"), name);
      fill(`docs/${name}`, { name: "x.md", kind: "file" });
    }
    expect(await fileStillPresent(home, "docs", deep, 1_000, { left: 0, fits: new Map() })).toBeNull();
    const adapter = createMatrixFilesAdapter(home);
    const config = { roots: ["docs"], extensions: ["md"], maxFileBytes: 1_000 };
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:x");
    const run = (maxPages?: number) => runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config, { maxPages });
    expect(await run()).toMatchObject({ caughtUp: true, written: 13 });
    const cursor = (await harness.repository.getSyncCursor(matrixScope, sourceId))!.cursor;
    const sweep = encodeMatrixCursor("mf1:", { v: 1, phase: "sweep", after: null });
    await harness.repository.applySyncBatch(matrixScope, { sourceId, expectedCursor: cursor, nextCursor: sweep, upserts: [], deletions: [] });
    const read = () => listings.reduce((sum, listing) => sum + listing.read, 0);
    for (const listing of listings) listing.read = 0;
    // The budget runs out after the deep file's first folder: the page ends there instead of reading 10 more.
    expect(await run(1)).toMatchObject({ caughtUp: false, deleted: 0 });
    expect(read()).toBeLessThanOrEqual(dirReadsPerPage + max);
    for (const listing of listings) listing.read = 0;
    // The next page starts at the deep file and finishes its check.
    expect(await run(1)).toMatchObject({ caughtUp: true, deleted: 0 });
    expect(read()).toBe(folders.length * max);
  });

  it("leaves out a folder over the entry bound whole and sweeps the documents of its files", async () => {
    const max = BRAIN_MATRIX_LIMITS.dirEntriesMax;
    mkdirSync(join(home, "docs/sub"), { recursive: true });
    writeFileSync(join(home, "docs/a.md"), "a");
    writeFileSync(join(home, "docs/sub/b.md"), "b");
    const adapter = createMatrixFilesAdapter(home);
    const config = { roots: ["docs"], extensions: ["md"], maxFileBytes: 1_000 };
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:x");
    const run = () => runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config);
    expect(await run()).toMatchObject({ caughtUp: true, written: 2 });
    // sub grows past the bound with b.md read last: a capped read would never see b.md again and keep its old text.
    const hidden = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `.h${index}`, kind: "file" as const }));
    faults.listings.set(join(home, "docs/sub"), { entries: [...hidden(max), { name: "b.md", kind: "file" }], read: 0 });
    writeFileSync(join(home, "docs/sub/b.md"), "b changed");
    expect(await run()).toMatchObject({ caughtUp: true, written: 0, deleted: 1, notices: ["items_truncated"] });
    expect(await liveTitles(harness, sourceId)).toEqual(["docs/a.md"]);
    // Back at the bound, the folder is walked and kept again.
    faults.listings.set(join(home, "docs/sub"), { entries: [...hidden(max - 1), { name: "b.md", kind: "file" }], read: 0 });
    expect(await run()).toMatchObject({ caughtUp: true, written: 1, deleted: 0, notices: [] });
    expect(await liveTitles(harness, sourceId)).toEqual(["docs/a.md", "docs/sub/b.md"]);
  });

  it("writes no file of a folder over the entry bound, even one read before the bound", async () => {
    const max = BRAIN_MATRIX_LIMITS.dirEntriesMax;
    mkdirSync(join(home, "docs/sub"), { recursive: true });
    writeFileSync(join(home, "docs/a.md"), "a");
    writeFileSync(join(home, "docs/sub/b.md"), "b");
    const adapter = createMatrixFilesAdapter(home);
    const config = { roots: ["docs"], extensions: ["md"], maxFileBytes: 1_000 };
    const sourceId = await createMatrixSource(harness, "matrix_files", "matrix_files:x");
    const run = () => runMatrixLoop(harness, sourceId, "matrix_files:x", adapter, config);
    expect(await run()).toMatchObject({ caughtUp: true, written: 2 });
    // b.md comes first, then the bound: a scan that kept the files it read would write b.md and the sweep drop it.
    const hidden = Array.from({ length: max }, (_, index) => ({ name: `.h${index}`, kind: "file" as const }));
    faults.listings.set(join(home, "docs/sub"), { entries: [{ name: "b.md", kind: "file" }, ...hidden], read: 0 });
    writeFileSync(join(home, "docs/sub/b.md"), "b changed");
    expect(await run()).toMatchObject({ caughtUp: true, written: 0, deleted: 1, notices: ["items_truncated"] });
    // The next pass agrees with the sweep: nothing written again, nothing left to drop.
    expect(await run()).toMatchObject({ caughtUp: true, written: 0, deleted: 0 });
    expect(await liveTitles(harness, sourceId)).toEqual(["docs/a.md"]);
  });

  it("reads a file to its end when a read returns fewer bytes than asked", async () => {
    writeFileSync(join(home, "a.md"), "a\u00e9 b");
    // The first read stops inside the two bytes of "\u00e9".
    faults.shortRead = 2;
    expect(await readTextFile(join(home, "a.md"), 100)).toMatchObject({ kind: "text", text: "a\u00e9 b", bytes: 5 });
    // A read of no bytes is the end of the file (it shrank since the open): the read stops with what it has.
    faults.shortRead = 0;
    expect(await readTextFile(join(home, "a.md"), 100)).toMatchObject({ kind: "text", text: "", bytes: 0 });
  });

  it("refuses a file whose folder is swapped for a symlink while the walk is reading", async () => {
    mkdirSync(join(home, "docs/sub"), { recursive: true });
    for (const name of ["a.md", "b.md"]) writeFileSync(join(home, "docs/sub", name), name);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "brain-matrix-outside-")));
    writeFileSync(join(outside, "b.md"), "OUTSIDE SECRET");
    const budget: WalkBudget = {
      entries: 10, reads: 100_000, pathBytes: 1_000, position: null, truncated: () => undefined, secretSkipped: () => undefined,
    };
    const texts: string[] = [];
    try {
      // The walk lists docs/sub, then the folder becomes a symlink to a folder outside home before b.md is read.
      for await (const entry of walkFiles(join(home, "docs"), [], null, budget)) {
        const outcome = await readTextFile(entry.path, 100);
        texts.push(outcome.kind === "text" ? outcome.text : outcome.kind);
        if (texts.length === 1) {
          renameSync(join(home, "docs/sub"), join(home, "docs/real"));
          symlinkSync(outside, join(home, "docs/sub"));
        }
      }
      expect(texts).toEqual(["a.md", "gone"]);
      // Swapped back right after the open: the folder resolves to itself again, but the open file is not the one there.
      faults.afterOpen = () => {
        unlinkSync(join(home, "docs/sub"));
        renameSync(join(home, "docs/real"), join(home, "docs/sub"));
      };
      expect(await readTextFile(join(home, "docs/sub/b.md"), 100)).toEqual({ kind: "gone" });
      expect(await readTextFile(join(home, "docs/sub/b.md"), 100)).toMatchObject({ kind: "text", text: "b.md" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
