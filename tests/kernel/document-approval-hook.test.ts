import { describe, expect, it, vi } from "vitest";
import { createDocumentApprovalHook, type HookInput } from "../../packages/kernel/src/hooks.js";

const GATED = [
  "mcp__matrix-os-ipc__document_accept_revisions",
  "mcp__matrix-os-ipc__document_reject_revisions",
  "mcp__matrix-os-ipc__sheet_accept_changes",
  "mcp__matrix-os-ipc__sheet_reject_changes",
];

function input(toolName: string, toolInput: unknown = { path: "docs/terms.docx", ids: "all" }): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s1" };
}

describe("document approval hook", () => {
  // Fault detected: proposals and reads stall on an approval prompt the owner never needed.
  it("lets reads and proposals through without asking", async () => {
    const requestApproval = vi.fn(async () => false);
    const hook = createDocumentApprovalHook(requestApproval);
    for (const name of ["mcp__matrix-os-ipc__document_propose_edits", "mcp__matrix-os-ipc__sheet_read_range", "mcp__matrix-os-ipc__document_describe", "Bash"]) {
      expect(await hook(input(name))).toEqual({});
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // Fault detected: an approved resolution is blocked, or the owner is asked about the wrong file.
  it("allows a resolution the owner approves, showing the owner the exact request", async () => {
    const requestApproval = vi.fn(async () => true);
    const hook = createDocumentApprovalHook(requestApproval);
    for (const name of GATED) {
      expect(await hook(input(name, { path: "docs/q3.xlsx", ids: ["c1"] }))).toEqual({});
      expect(requestApproval).toHaveBeenLastCalledWith(name, { path: "docs/q3.xlsx", ids: ["c1"] });
    }
    expect(requestApproval).toHaveBeenCalledTimes(GATED.length);
  });

  // Fault detected: the agent accepts or rejects proposals on the owner's behalf after a denial.
  it("denies a resolution the owner declines", async () => {
    const hook = createDocumentApprovalHook(vi.fn(async () => false));
    for (const name of GATED) {
      const result = await hook(input(name));
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(result.systemMessage).toMatch(/denied/i);
    }
  });

  // Fault detected: an approval transport failure or timeout silently lets the change through.
  it("fails closed when approval cannot be obtained", async () => {
    const hook = createDocumentApprovalHook(vi.fn(async () => { throw new Error("socket closed"); }));
    for (const name of GATED) {
      const result = await hook(input(name));
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(result.systemMessage).not.toContain("socket closed");
    }
  });
});
