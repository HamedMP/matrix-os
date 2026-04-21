import { describe, it, expect } from "vitest";
import { resolveWithinPrefix, validatePathBatch } from "../../../packages/gateway/src/sync/path-validation.js";

describe("resolveWithinPrefix", () => {
  const userId = "user-123";

  it("accepts a valid relative path", () => {
    const result = resolveWithinPrefix(userId, "apps/calculator/index.html");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.key).toBe("matrixos-sync/user-123/files/apps/calculator/index.html");
    }
  });

  it("accepts a single-segment path", () => {
    const result = resolveWithinPrefix(userId, "file.txt");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.key).toBe("matrixos-sync/user-123/files/file.txt");
    }
  });

  it("rejects empty path", () => {
    const result = resolveWithinPrefix(userId, "");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("empty");
    }
  });

  it("rejects path starting with /", () => {
    const result = resolveWithinPrefix(userId, "/etc/passwd");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("/");
    }
  });

  it("rejects path with .. traversal at the start", () => {
    const result = resolveWithinPrefix(userId, "../secret/file.txt");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("..");
    }
  });

  it("rejects path with .. traversal in the middle", () => {
    const result = resolveWithinPrefix(userId, "apps/../../../etc/passwd");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("..");
    }
  });

  it("rejects path that is exactly '..'", () => {
    const result = resolveWithinPrefix(userId, "..");
    expect(result.valid).toBe(false);
  });

  it("rejects path ending with /..", () => {
    const result = resolveWithinPrefix(userId, "apps/test/..");
    expect(result.valid).toBe(false);
  });

  it("rejects path exceeding 1024 characters", () => {
    const longPath = "a".repeat(1025);
    const result = resolveWithinPrefix(userId, longPath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("1024");
    }
  });

  it("accepts path at exactly 1024 characters", () => {
    const maxPath = "a".repeat(1024);
    const result = resolveWithinPrefix(userId, maxPath);
    expect(result.valid).toBe(true);
  });

  it("rejects path with null bytes", () => {
    const result = resolveWithinPrefix(userId, "file\0.txt");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("null");
    }
  });

  it("normalizes consecutive slashes", () => {
    const result = resolveWithinPrefix(userId, "apps//calculator///index.html");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.key).toBe("matrixos-sync/user-123/files/apps/calculator/index.html");
    }
  });

  it("strips trailing slash", () => {
    const result = resolveWithinPrefix(userId, "apps/calculator/");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.key).toBe("matrixos-sync/user-123/files/apps/calculator");
    }
  });

  it("normalizes single-dot path segments", () => {
    const result = resolveWithinPrefix(userId, "apps/./calculator/./index.html");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.key).toBe("matrixos-sync/user-123/files/apps/calculator/index.html");
    }
  });

  it("rejects path that resolves to empty after normalization", () => {
    const result = resolveWithinPrefix(userId, "/");
    expect(result.valid).toBe(false);
  });
});

describe("validatePathBatch", () => {
  const userId = "user-abc";

  it("separates valid and invalid paths", () => {
    const paths = [
      "apps/index.html",
      "../etc/passwd",
      "system/soul.md",
      "",
    ];
    const result = validatePathBatch(userId, paths);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(2);
    expect(result.valid[0]).toBe("matrixos-sync/user-abc/files/apps/index.html");
    expect(result.valid[1]).toBe("matrixos-sync/user-abc/files/system/soul.md");
  });

  it("returns all valid for clean batch", () => {
    const paths = ["a.txt", "b/c.txt"];
    const result = validatePathBatch(userId, paths);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(0);
  });

  it("handles empty batch", () => {
    const result = validatePathBatch(userId, []);
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(0);
  });
});
