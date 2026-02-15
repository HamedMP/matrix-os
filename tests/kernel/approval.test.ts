import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldRequireApproval,
  DEFAULT_APPROVAL_POLICY,
  type ApprovalPolicy,
} from "../../packages/kernel/src/approval.js";
import { createApprovalHook, type HookInput } from "../../packages/kernel/src/hooks.js";

describe("Approval policy", () => {
  describe("shouldRequireApproval", () => {
    it("returns true for Bash with destructive patterns (rm -rf)", () => {
      expect(
        shouldRequireApproval("Bash", { command: "rm -rf /tmp/data" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(true);
    });

    it("returns true for Bash with kill command", () => {
      expect(
        shouldRequireApproval("Bash", { command: "kill -9 1234" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(true);
    });

    it("returns true for Bash with drop table", () => {
      expect(
        shouldRequireApproval("Bash", { command: "sqlite3 db.sqlite 'DROP TABLE users'" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(true);
    });

    it("returns true for Write to system paths", () => {
      expect(
        shouldRequireApproval("Write", { file_path: "/home/user/matrixos/system/config.json" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(true);
    });

    it("returns false for safe ops (Read)", () => {
      expect(
        shouldRequireApproval("Read", { file_path: "/some/file.txt" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(false);
    });

    it("returns false for auto-approved IPC tools", () => {
      expect(
        shouldRequireApproval("mcp__matrix-os-ipc__list_tasks", {}, DEFAULT_APPROVAL_POLICY),
      ).toBe(false);

      expect(
        shouldRequireApproval("mcp__matrix-os-ipc__read_state", {}, DEFAULT_APPROVAL_POLICY),
      ).toBe(false);

      expect(
        shouldRequireApproval("mcp__matrix-os-ipc__load_skill", { skill_name: "weather" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(false);
    });

    it("returns false for safe Bash commands", () => {
      expect(
        shouldRequireApproval("Bash", { command: "ls -la" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(false);

      expect(
        shouldRequireApproval("Bash", { command: "cat file.txt" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(false);
    });

    it("returns false for Write to non-system paths", () => {
      expect(
        shouldRequireApproval("Write", { file_path: "/home/user/matrixos/apps/todo.html" }, DEFAULT_APPROVAL_POLICY),
      ).toBe(false);
    });

    it("custom policy overrides defaults", () => {
      const custom: ApprovalPolicy = {
        enabled: true,
        requireApproval: [{ tool: "Bash", argPatterns: { command: "npm" } }],
        autoApprove: ["Bash"],
        timeout: 15000,
      };

      expect(
        shouldRequireApproval("Bash", { command: "npm install malicious-pkg" }, custom),
      ).toBe(true);

      expect(
        shouldRequireApproval("Bash", { command: "ls" }, custom),
      ).toBe(false);
    });

    it("returns false when policy is disabled", () => {
      const disabled: ApprovalPolicy = {
        ...DEFAULT_APPROVAL_POLICY,
        enabled: false,
      };

      expect(
        shouldRequireApproval("Bash", { command: "rm -rf /" }, disabled),
      ).toBe(false);
    });
  });

  describe("createApprovalHook", () => {
    const makeInput = (toolName: string, toolInput: unknown): HookInput => ({
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      session_id: "test-session",
    });

    it("calls requestApproval for destructive Bash and returns allow on approve", async () => {
      const requestApproval = vi.fn().mockResolvedValue(true);
      const hook = createApprovalHook(DEFAULT_APPROVAL_POLICY, requestApproval);

      const result = await hook(makeInput("Bash", { command: "rm -rf /tmp" }));

      expect(requestApproval).toHaveBeenCalledWith("Bash", { command: "rm -rf /tmp" });
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    it("returns deny when user denies approval", async () => {
      const requestApproval = vi.fn().mockResolvedValue(false);
      const hook = createApprovalHook(DEFAULT_APPROVAL_POLICY, requestApproval);

      const result = await hook(makeInput("Bash", { command: "rm -rf /tmp" }));

      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(result.systemMessage).toContain("denied");
    });

    it("does not call requestApproval for safe tools", async () => {
      const requestApproval = vi.fn();
      const hook = createApprovalHook(DEFAULT_APPROVAL_POLICY, requestApproval);

      await hook(makeInput("Read", { file_path: "/some/file" }));

      expect(requestApproval).not.toHaveBeenCalled();
    });

    it("auto-denies on timeout (requestApproval rejects)", async () => {
      const requestApproval = vi.fn().mockRejectedValue(new Error("Approval timed out"));
      const hook = createApprovalHook(DEFAULT_APPROVAL_POLICY, requestApproval);

      const result = await hook(makeInput("Bash", { command: "rm -rf /data" }));

      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(result.systemMessage).toContain("timed out");
    });
  });
});
