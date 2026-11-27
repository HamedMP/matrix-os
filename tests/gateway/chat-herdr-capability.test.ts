import { describe, expect, it } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";

const target = { chatId: "chat_one", worktreeId: "wt_1234567890abcdef", executionRoot: "/repo/worktree",
  ref: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: "tt_" + "a".repeat(32) }, revision: "c".repeat(64) };
const owner = { type: "personal", ownerId: "user_matrix" };
const input = { scope: "chat_herdr" as const, owner, runId: "run_one", fullAccess: true, herdr: target };
const path = "/api/chat/herdr-terminal";
describe("selected Herdr terminal authority", () => {
  it("only admits the terminal action route and aborts an in-flight lease when the run ends", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const grant = registry.issue(input)!;
    const run = registry.resolveRunContext(grant.token, "POST", path)!;
    expect(run.herdr).toMatchObject(target);
    expect(registry.resolve(grant.token, "POST", "/api/mcp-servers/core/call")).toBeNull();
    expect(registry.resolve(grant.token, "GET", "/api/terminal/herdr")).toBeNull();
    const other = registry.issue({ ...input, herdr: undefined, scope: "chat_call" })!;
    expect(registry.resolve(other.token, "POST", path)).toBeNull();
    grant.revoke();
    expect(run.herdr?.signal.aborted).toBe(true);
    expect(registry.resolve(grant.token, "POST", path)).toBeNull();
    registry.close();
  });

  it("rejects a missing target, another owner, preview runtime or a broader scope", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    expect(registry.issue({ ...input, herdr: undefined })).toBeNull();
    expect(registry.issue({ ...input, fullAccess: false })).toBeNull();
    expect(registry.issue({ ...input, driveContext: true })).toBeNull();
    expect(registry.issue({ ...input, scope: "call" })).toBeNull();
    expect(registry.issue({ ...input, owner: { ...owner, ownerId: "user_other" } })).toBeNull();
    expect(createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId, previewRuntime: true }).issue(input)).toBeNull();
    registry.close();
  });
});
