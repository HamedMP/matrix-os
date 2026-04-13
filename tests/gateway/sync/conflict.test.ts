import { describe, it, expect } from "vitest";
import type { ManifestEntry } from "../../../packages/gateway/src/sync/types.js";

const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);
const HASH_C = "sha256:" + "c".repeat(64);

import {
  detectConflict,
  mergeText,
  createConflictCopyPath,
  isTextFile,
  TEXT_EXTENSIONS,
} from "../../../packages/gateway/src/sync/conflict.js";

describe("detectConflict", () => {
  it("detects conflict when both sides changed from base", () => {
    const result = detectConflict({
      localHash: HASH_A,
      remoteHash: HASH_B,
      baseHash: HASH_C,
    });
    expect(result).toBe(true);
  });

  it("no conflict when local matches remote", () => {
    const result = detectConflict({
      localHash: HASH_A,
      remoteHash: HASH_A,
      baseHash: HASH_C,
    });
    expect(result).toBe(false);
  });

  it("no conflict when only local changed", () => {
    const result = detectConflict({
      localHash: HASH_A,
      remoteHash: HASH_C,
      baseHash: HASH_C,
    });
    expect(result).toBe(false);
  });

  it("no conflict when only remote changed", () => {
    const result = detectConflict({
      localHash: HASH_C,
      remoteHash: HASH_B,
      baseHash: HASH_C,
    });
    expect(result).toBe(false);
  });

  it("no conflict when nothing changed", () => {
    const result = detectConflict({
      localHash: HASH_A,
      remoteHash: HASH_A,
      baseHash: HASH_A,
    });
    expect(result).toBe(false);
  });
});

describe("mergeText", () => {
  it("auto-merges non-overlapping changes", () => {
    const base = "line1\nline2\nline3\n";
    const local = "line1-changed\nline2\nline3\n";
    const remote = "line1\nline2\nline3-changed\n";

    const result = mergeText(local, base, remote);

    expect(result.conflict).toBe(false);
    expect(result.merged).toContain("line1-changed");
    expect(result.merged).toContain("line3-changed");
  });

  it("reports conflict on overlapping changes", () => {
    const base = "line1\nline2\nline3\n";
    const local = "line1-A\nline2\nline3\n";
    const remote = "line1-B\nline2\nline3\n";

    const result = mergeText(local, base, remote);

    expect(result.conflict).toBe(true);
  });

  it("handles identical changes as clean merge", () => {
    const base = "line1\nline2\n";
    const local = "line1-same\nline2\n";
    const remote = "line1-same\nline2\n";

    const result = mergeText(local, base, remote);

    expect(result.conflict).toBe(false);
    expect(result.merged).toContain("line1-same");
  });
});

describe("createConflictCopyPath", () => {
  it("creates conflict path with peerId and date", () => {
    const result = createConflictCopyPath("apps/readme.md", "hamed-macbook", new Date("2026-04-14"));

    expect(result).toBe("apps/readme (conflict - hamed-macbook - 2026-04-14).md");
  });

  it("handles files without extension", () => {
    const result = createConflictCopyPath("Makefile", "peer1", new Date("2026-01-01"));

    expect(result).toBe("Makefile (conflict - peer1 - 2026-01-01)");
  });

  it("handles deeply nested paths", () => {
    const result = createConflictCopyPath("a/b/c/file.txt", "peer", new Date("2026-06-15"));

    expect(result).toBe("a/b/c/file (conflict - peer - 2026-06-15).txt");
  });
});

describe("isTextFile", () => {
  it("recognizes all specified text extensions", () => {
    for (const ext of TEXT_EXTENSIONS) {
      expect(isTextFile(`file${ext}`)).toBe(true);
    }
  });

  it("treats unknown extensions as binary", () => {
    expect(isTextFile("image.png")).toBe(false);
    expect(isTextFile("archive.zip")).toBe(false);
    expect(isTextFile("database.sqlite")).toBe(false);
  });

  it("handles files without extension as binary", () => {
    expect(isTextFile("Makefile")).toBe(false);
  });

  it("is case-insensitive for extensions", () => {
    expect(isTextFile("README.MD")).toBe(true);
    expect(isTextFile("script.PY")).toBe(true);
  });
});
