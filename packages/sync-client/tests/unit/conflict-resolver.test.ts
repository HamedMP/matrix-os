import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveTextConflict,
  resolveBinaryConflict,
  generateConflictPath,
  isTextFile,
  type ConflictResult,
} from "../../src/daemon/conflict-resolver.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-conflict-test");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("isTextFile", () => {
  it("identifies TypeScript files as text", () => {
    expect(isTextFile("src/index.ts")).toBe(true);
    expect(isTextFile("component.tsx")).toBe(true);
  });

  it("identifies JavaScript files as text", () => {
    expect(isTextFile("app.js")).toBe(true);
    expect(isTextFile("component.jsx")).toBe(true);
  });

  it("identifies markup and data files as text", () => {
    expect(isTextFile("page.html")).toBe(true);
    expect(isTextFile("data.json")).toBe(true);
    expect(isTextFile("config.yaml")).toBe(true);
    expect(isTextFile("config.toml")).toBe(true);
    expect(isTextFile("doc.xml")).toBe(true);
    expect(isTextFile("icon.svg")).toBe(true);
  });

  it("identifies style files as text", () => {
    expect(isTextFile("styles.css")).toBe(true);
  });

  it("identifies documentation files as text", () => {
    expect(isTextFile("README.md")).toBe(true);
    expect(isTextFile("notes.txt")).toBe(true);
  });

  it("identifies script files as text", () => {
    expect(isTextFile("run.sh")).toBe(true);
    expect(isTextFile("app.py")).toBe(true);
    expect(isTextFile("main.go")).toBe(true);
    expect(isTextFile("lib.rs")).toBe(true);
  });

  it("identifies binary files as non-text", () => {
    expect(isTextFile("image.png")).toBe(false);
    expect(isTextFile("photo.jpg")).toBe(false);
    expect(isTextFile("archive.zip")).toBe(false);
    expect(isTextFile("app.wasm")).toBe(false);
    expect(isTextFile("font.woff2")).toBe(false);
  });

  it("identifies files without extension as non-text", () => {
    expect(isTextFile("Makefile")).toBe(false);
    expect(isTextFile("LICENSE")).toBe(false);
  });
});

describe("generateConflictPath", () => {
  it("generates correct conflict path with peerId and date", () => {
    const result = generateConflictPath(
      "src/index.ts",
      "hamed-macbook",
      new Date("2026-04-14"),
    );

    expect(result).toBe("src/index (conflict - hamed-macbook - 2026-04-14).ts");
  });

  it("handles files with no directory component", () => {
    const result = generateConflictPath(
      "README.md",
      "peer-1",
      new Date("2026-01-15"),
    );

    expect(result).toBe("README (conflict - peer-1 - 2026-01-15).md");
  });

  it("handles files with multiple dots in name", () => {
    const result = generateConflictPath(
      "data/config.prod.json",
      "vps",
      new Date("2026-06-01"),
    );

    expect(result).toBe("data/config.prod (conflict - vps - 2026-06-01).json");
  });

  it("handles files with no extension", () => {
    const result = generateConflictPath(
      "Makefile",
      "peer-1",
      new Date("2026-04-14"),
    );

    expect(result).toBe("Makefile (conflict - peer-1 - 2026-04-14)");
  });

  it("handles deeply nested paths", () => {
    const result = generateConflictPath(
      "packages/gateway/src/sync/routes.ts",
      "cloud-vps",
      new Date("2026-03-20"),
    );

    expect(result).toBe(
      "packages/gateway/src/sync/routes (conflict - cloud-vps - 2026-03-20).ts",
    );
  });

  it("sanitizes peerId before interpolating it into the conflict filename", () => {
    const result = generateConflictPath(
      "src/index.ts",
      "../../evil/peer id",
      new Date("2026-04-14"),
    );

    expect(result).toBe("src/index (conflict - evil_peer_id - 2026-04-14).ts");
  });
});

describe("resolveTextConflict", () => {
  it("auto-merges when changes are in different regions", async () => {
    const base = "line 1\nline 2\nline 3\n";
    const local = "line 1 modified\nline 2\nline 3\n";
    const remote = "line 1\nline 2\nline 3 modified\n";

    const result = await resolveTextConflict(base, local, remote, {
      filePath: "test.ts",
      peerId: "peer-1",
    });

    expect(result.merged).toBe(true);
    expect(result.content).toContain("line 1 modified");
    expect(result.content).toContain("line 3 modified");
    expect(result.conflictPath).toBeUndefined();
  });

  it("returns conflict when both sides change the same region", async () => {
    const base = "line 1\nline 2\nline 3\n";
    const local = "line 1\nlocal change\nline 3\n";
    const remote = "line 1\nremote change\nline 3\n";

    const result = await resolveTextConflict(base, local, remote, {
      filePath: "test.ts",
      peerId: "peer-1",
    });

    expect(result.merged).toBe(false);
    expect(result.conflictPath).toBeDefined();
    // Conflict content should contain git-style markers
    expect(result.content).toContain("<<<<<<<");
    expect(result.content).toContain("=======");
    expect(result.content).toContain(">>>>>>>");
  });

  it("handles identical changes from both sides (no conflict)", async () => {
    const base = "line 1\nline 2\nline 3\n";
    const local = "line 1\nsame change\nline 3\n";
    const remote = "line 1\nsame change\nline 3\n";

    const result = await resolveTextConflict(base, local, remote, {
      filePath: "test.ts",
      peerId: "peer-1",
    });

    expect(result.merged).toBe(true);
    expect(result.content).toContain("same change");
  });

  it("handles empty base (new file on both sides)", async () => {
    const base = "";
    const local = "local content\n";
    const remote = "remote content\n";

    const result = await resolveTextConflict(base, local, remote, {
      filePath: "new-file.ts",
      peerId: "peer-1",
    });

    // Both created a new file with different content -> conflict
    expect(result.merged).toBe(false);
  });
});

describe("resolveBinaryConflict", () => {
  it("creates a conflict copy of the remote file", async () => {
    const localPath = join(TEST_DIR, "image.png");
    const remoteContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await writeFile(localPath, Buffer.from([0x00, 0x01, 0x02]));

    const result = await resolveBinaryConflict({
      filePath: "image.png",
      syncRoot: TEST_DIR,
      remoteContent,
      peerId: "peer-2",
      date: new Date("2026-04-14"),
    });

    expect(result.merged).toBe(false);
    expect(result.conflictPath).toMatch(
      /image \(conflict - peer-2 - 2026-04-14\)\.png$/,
    );

    // Verify conflict copy was written
    const conflictContent = await readFile(
      join(TEST_DIR, result.conflictPath!),
    );
    expect(conflictContent).toEqual(remoteContent);
  });

  it("preserves the original file untouched", async () => {
    const originalContent = Buffer.from([0x00, 0x01, 0x02]);
    const localPath = join(TEST_DIR, "doc.pdf");
    await writeFile(localPath, originalContent);

    await resolveBinaryConflict({
      filePath: "doc.pdf",
      syncRoot: TEST_DIR,
      remoteContent: Buffer.from([0x03, 0x04, 0x05]),
      peerId: "peer-2",
      date: new Date("2026-04-14"),
    });

    const preserved = await readFile(localPath);
    expect(preserved).toEqual(originalContent);
  });

  it("keeps the conflict copy inside syncRoot when peerId contains path characters", async () => {
    const remoteContent = Buffer.from([0x10, 0x20, 0x30]);

    const result = await resolveBinaryConflict({
      filePath: "nested/image.png",
      syncRoot: TEST_DIR,
      remoteContent,
      peerId: "../../outside/path",
      date: new Date("2026-04-14"),
    });

    expect(result.conflictPath).toBe(
      "nested/image (conflict - outside_path - 2026-04-14).png",
    );
    const written = await readFile(join(TEST_DIR, result.conflictPath!));
    expect(written).toEqual(remoteContent);
  });
});
