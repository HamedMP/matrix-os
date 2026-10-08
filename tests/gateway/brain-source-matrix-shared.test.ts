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
  cutUtf8, decodeMatrixCursor, documentTitle, guardRead, isoInstant, resumeIndex,
} from "../../packages/gateway/src/brain/sources/matrix/shared.js";
import { parseChatConfig } from "../../packages/gateway/src/brain/sources/matrix/config.js";
import { BrainFeatureError } from "../../packages/gateway/src/brain/contracts.js";
import { z } from "zod/v4";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { createMatrixSource, liveTitles, matrixScope, runMatrixLoop } from "./helpers/brain-source-matrix-loop.js";

const faults = vi.hoisted(() => ({
  realpath: new Map<string, Error | string>(),
  lstat: new Map<string, Error | "other-inode">(),
  afterOpen: null as (() => void) | null,
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
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
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
    await expect(fileStillPresent(home, "docs/a.md", 10)).rejects.toThrow("io");
    await expect(run()).rejects.toThrow("io");
    faults.realpath.clear();
    faults.lstat.clear();
    faults.realpath.set(join(home, "docs/sub"), io());
    await expect(run()).rejects.toThrow("io");

    // The folder picker passes file system failures that are not a missing entry through as well.
    faults.realpath.set(home, io());
    const handler = createBrainMatrixFilesHandler({ kysely: harness.db, homePath: home });
    const project = { projectId: "proj_a", slug: "a", name: "A", scope: matrixScope };
    await expect(handler.listOptions!("owner_a", project, {}, new AbortController().signal)).rejects.toThrow("io");
  });

  it("refuses a file whose folder is swapped for a symlink while the walk is reading", async () => {
    mkdirSync(join(home, "docs/sub"), { recursive: true });
    for (const name of ["a.md", "b.md"]) writeFileSync(join(home, "docs/sub", name), name);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "brain-matrix-outside-")));
    writeFileSync(join(outside, "b.md"), "OUTSIDE SECRET");
    const budget: WalkBudget = { entries: 10, pathBytes: 1_000, position: null, truncated: () => undefined };
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
