import { describe, expect, it } from "vitest";
import {
  detectGitReferences,
  detectPackageSpecifiers,
} from "../web-link-provider.js";

describe("terminal web link provider extended detection", () => {
  it("detects commit SHAs", () => {
    const matches = detectGitReferences("commit a3f8d9c1b2a3e4f5678901234567890abcdef123");

    expect(matches).toEqual([
      {
        kind: "commit",
        text: "a3f8d9c1b2a3e4f5678901234567890abcdef123",
        startIndex: 7,
      },
    ]);
  });

  it("detects issue references", () => {
    const matches = detectGitReferences("Fixes #123 and refs #456");

    expect(matches).toEqual([
      { kind: "issue", text: "#123", startIndex: 6 },
      { kind: "issue", text: "#456", startIndex: 20 },
    ]);
  });

  it("detects npm and pnpm package specifiers", () => {
    const matches = detectPackageSpecifiers("Install npm:@scope/pkg@1.2.3 or pnpm:vite");

    expect(matches).toEqual([
      { kind: "package", text: "npm:@scope/pkg@1.2.3", startIndex: 8 },
      { kind: "package", text: "pnpm:vite", startIndex: 32 },
    ]);
  });
});
