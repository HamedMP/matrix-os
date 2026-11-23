import { describe, expect, it } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { claudeFallbackCatalog } from "../../packages/gateway/src/chat/claude-model-catalog.js";
import { chatPermissionModeLabel } from "../../packages/ui/src/chat/composer/permission-mode-label.js";

describe("provider-specific chat permissions", () => {
  it("names Codex's reviewer choice separately from Claude's permission modes", () => {
    expect(chatPermissionModeLabel("supervised", "codex")).toBe("Ask for approval");
    expect(chatPermissionModeLabel("auto_review", "codex")).toBe("Approve for me");
    expect(chatPermissionModeLabel("auto_accept_edits", "claude_code")).toBe("Accept edits");
    expect(chatPermissionModeLabel("auto", "claude_code")).toBe("Auto");
  });

  it("selects the Codex reviewer without removing the workspace sandbox", () => {
    const launch = buildAgentLaunch({
      agent: "codex", cwd: "/tmp/project", prompt: "Review the project",
      providerEventPath: "/tmp/provider-preferences-events.jsonl",
      approvalPolicy: "auto-review",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/tmp/project"] },
    });
    const config = JSON.parse(Buffer.from(launch.args.at(-1)!, "base64").toString("utf8"));
    expect(config).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review",
      sandbox: "workspace-write", writableRoots: ["/tmp/project"] });
  });

  it("explicitly selects the human reviewer when automatic review is off", () => {
    const launch = buildAgentLaunch({
      agent: "codex", cwd: "/tmp/project", prompt: "Review the project",
      providerEventPath: "/tmp/provider-preferences-events.jsonl", approvalPolicy: "on-request",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/tmp/project"] },
    });
    const config = JSON.parse(Buffer.from(launch.args.at(-1)!, "base64").toString("utf8"));
    expect(config.approvalsReviewer).toBe("user");
  });

  it("offers Claude's extra-high effort without exposing Codex-only levels", () => {
    expect(claudeFallbackCatalog().options[0]!.values?.map(option => option.value))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
