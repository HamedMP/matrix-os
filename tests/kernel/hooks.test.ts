import { describe, it, expect } from "vitest";
import {
  safetyGuardHook,
  updateStateHook,
  logActivityHook,
  gitSnapshotHook,
  preCompactHook,
} from "../../packages/kernel/src/hooks.js";
import type { HookInput } from "../../packages/kernel/src/hooks.js";

function makeHookInput(
  toolName: string,
  toolInput: unknown = {},
  toolResponse: unknown = "ok",
): HookInput {
  return {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    session_id: "test-session",
  };
}

describe("safetyGuardHook", () => {
  it("denies rm -rf /", async () => {
    const input = makeHookInput("Bash", { command: "rm -rf /" });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies rm -rf on home directory", async () => {
    const input = makeHookInput("Bash", { command: "rm -rf ~/" });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows safe bash commands", async () => {
    const input = makeHookInput("Bash", { command: "ls -la" });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("denies writes to protected system paths", async () => {
    const input = makeHookInput("Write", {
      file_path: "/etc/passwd",
    });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("updateStateHook", () => {
  it("returns a valid hook response", async () => {
    const input = makeHookInput("Write", {
      file_path: "/home/user/matrixos/apps/todo.html",
    });
    const result = await updateStateHook(input);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});

describe("logActivityHook", () => {
  it("returns a valid hook response", async () => {
    const input = makeHookInput("Bash", { command: "npm install" });
    const result = await logActivityHook(input);
    expect(result).toBeDefined();
  });
});

describe("gitSnapshotHook", () => {
  it("returns a valid hook response for Write", async () => {
    const input = makeHookInput("Write", {
      file_path: "/home/user/matrixos/apps/todo.html",
    });
    const result = await gitSnapshotHook(input);
    expect(result).toBeDefined();
  });
});

describe("preCompactHook", () => {
  it("returns a valid hook response", async () => {
    const input: HookInput = {
      hook_event_name: "PreCompact",
      session_id: "test-session",
    };
    const result = await preCompactHook(input);
    expect(result).toBeDefined();
  });
});
