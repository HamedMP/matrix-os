import { describe, expect, it, vi } from "vitest";
import {
  GIT_MAX_BUFFER_BYTES,
  GIT_TIMEOUT_MS,
  isGitAncestor,
  readGitChangedPaths,
} from "../../scripts/ci/git-coverage.mjs";

describe("CI git coverage helpers", () => {
  it("distinguishes a non-ancestor from an invalid git comparison", () => {
    const spawnGit = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 128, stdout: "", stderr: "bad revision" });

    expect(isGitAncestor("a".repeat(40), "b".repeat(40), { spawnGit })).toBe(false);
    expect(() => isGitAncestor("a".repeat(40), "b".repeat(40), { spawnGit }))
      .toThrow("Git ancestry check failed");
  });

  it("reads a bounded NUL-delimited cumulative diff", () => {
    const spawnGit = vi.fn(() => ({
      status: 0,
      stdout: "docs/a.md\0packages/gateway/src/server.ts\0",
      stderr: "",
    }));

    expect(
      readGitChangedPaths("a".repeat(40), "b".repeat(40), { spawnGit }),
    ).toEqual(["docs/a.md", "packages/gateway/src/server.ts"]);
    expect(spawnGit).toHaveBeenCalledWith(
      "git",
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${"a".repeat(40)}..${"b".repeat(40)}`,
        "--",
      ],
      expect.objectContaining({
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      }),
    );
  });
});
