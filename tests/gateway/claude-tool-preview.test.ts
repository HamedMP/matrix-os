import { describe, expect, it } from "vitest";
import { projectClaudeToolPreview } from "../../packages/gateway/src/chat/claude-tool-preview.js";

const owner = { homePath: "/safe/home", executionRoot: "/safe/project", showPrivatePaths: true };

describe("Claude tool activity projection", () => {
  it("preserves owner file previews and keeps shared file paths scoped", () => {
    expect(projectClaudeToolPreview("Read", { file_path: "/safe/project/src/streaming.ts" }, owner))
      .toEqual({ preview: "/safe/project/src/streaming.ts", previewKind: "path" });
    expect(projectClaudeToolPreview("Read", { file_path: "/safe/project/src/streaming.ts" },
      { ...owner, showPrivatePaths: false })).toEqual({ preview: "src/streaming.ts", previewKind: "path" });
  });

  it("retains safe private-owner absolute file previews beyond known roots", () => {
    expect(projectClaudeToolPreview("Read", { file_path: "/private/other/account.txt" }, owner))
      .toEqual({ preview: "/private/other/account.txt", previewKind: "path" });
    expect(projectClaudeToolPreview("Read", { file_path: "/private/other/account.txt" },
      { ...owner, showPrivatePaths: false })).toEqual({});
  });

  it("keeps commands and working directories sanitized even for the owner", () => {
    expect(projectClaudeToolPreview("Bash", { command: "cat /safe/project/src/streaming.ts", cwd: "/safe/project" }, owner))
      .toEqual({ preview: "cat src/streaming.ts", previewKind: "command", detail: "Working directory: ." });
    expect(projectClaudeToolPreview("Bash", { command: "ANTHROPIC_API_KEY=secret-value" }, owner)).toEqual({});
  });

  it("does not revive credential-bearing file paths or arbitrary shared paths", () => {
    expect(projectClaudeToolPreview("Read", { file_path: "/safe/project/ANTHROPIC_API_KEY=secret-value" }, owner)).toEqual({});
    expect(projectClaudeToolPreview("Read", { file_path: "/private/other/account.txt" },
      { ...owner, showPrivatePaths: false })).toEqual({});
  });
});
