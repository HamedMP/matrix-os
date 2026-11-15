import { describe, expect, it, vi } from "vitest";
import { desktopDevRunTitle, parseDesktopDevRunLabel } from "@desktop/shared/dev-run-label";
import { resolveDesktopDevRunSummary } from "@desktop/main/dev-run-label";

describe("MATRIX_DESKTOP_DEV_LABEL parsing", () => {
  it("is opt-in: unset or blank labels leave dev runs unchanged", () => {
    expect(parseDesktopDevRunLabel(undefined, false)).toBeNull();
    expect(parseDesktopDevRunLabel("   \n\t ", false)).toBeNull();
  });
  it("ignores the label in packaged builds so releases are unaffected", () => {
    expect(parseDesktopDevRunLabel("PR #3314", true)).toBeNull();
  });
  it("trims, collapses control characters, and caps length", () => {
    expect(parseDesktopDevRunLabel("  PR #3314 · Core\u0007 MCP\napprovals\u001b[31m ", false)).toBe("PR #3314 · Core MCP approvals [31m");
    expect(parseDesktopDevRunLabel("x".repeat(200), false)).toHaveLength(80);
  });
  it("titles the window with the label", () => {
    expect(desktopDevRunTitle("PR #3314")).toBe("Matrix OS — PR #3314");
  });
});

describe("dev run summary", () => {
  it("includes git sha, branch, and origins as origins only", async () => {
    const readGit = vi.fn(async (args: string[]) => args.includes("--abbrev-ref") ? "feat/core-mcp" : "abc123def456");
    await expect(resolveDesktopDevRunSummary({ label: "PR #3314", readGit,
      platformOrigin: "https://pr-3314-preview.matrix-os.com/path?token=secret",
      apiOrigin: "https://pr-3314-preview.matrix-os.com" })).resolves.toEqual({
      label: "PR #3314", sha: "abc123def456", branch: "feat/core-mcp",
      platformOrigin: "https://pr-3314-preview.matrix-os.com", apiOrigin: null,
    });
  });
  it("tolerates git failures, detached HEAD, and malformed origins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readGit = vi.fn(async (args: string[]) => {
      if (args.includes("--abbrev-ref")) return "HEAD";
      throw new Error("git: not a repository");
    });
    await expect(resolveDesktopDevRunSummary({ label: "local", readGit, platformOrigin: "not a url", apiOrigin: "file:///etc" }))
      .resolves.toEqual({ label: "local", sha: null, branch: null, platformOrigin: null, apiOrigin: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("drops output that is not a short sha or safe branch name", async () => {
    const readGit = vi.fn(async (args: string[]) => args.includes("--abbrev-ref") ? "bad branch\n$(rm)" : "not-a-sha");
    await expect(resolveDesktopDevRunSummary({ label: "x", readGit, platformOrigin: "https://app.matrix-os.com", apiOrigin: "https://api.matrix-os.com" }))
      .resolves.toMatchObject({ sha: null, branch: null, apiOrigin: "https://api.matrix-os.com" });
  });
});
