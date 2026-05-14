import { describe, expect, it } from "vitest";
import { createSafeCloudSessionProjection } from "../../packages/gateway/src/workspace-event-publisher.js";

describe("workspace desktop contract", () => {
  it("projects running sessions as cloud runtime state without leaking host paths", () => {
    const projected = createSafeCloudSessionProjection({
      id: "sess_123",
      kind: "agent",
      agent: "codex",
      projectSlug: "repo",
      worktreeId: "wt_123",
      runtime: {
        type: "zellij",
        status: "running",
        zellijLayoutPath: "/Users/alice/.matrix/layouts/secret.kdl",
      },
      nativeAttachCommand: ["zellij", "attach", "matrix-sess_123"],
    } as any);

    expect(projected).toEqual({
      id: "sess_123",
      kind: "agent",
      agent: "codex",
      projectSlug: "repo",
      worktreeId: "wt_123",
      cloudRuntime: { mode: "cloud", status: "running", type: "zellij" },
      attach: { observe: true, takeOver: true },
    });
    expect(JSON.stringify(projected)).not.toContain("/Users/");
    expect(JSON.stringify(projected)).not.toContain("zellij attach");
  });
});
