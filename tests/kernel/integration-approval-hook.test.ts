import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listServices } from "../../packages/gateway/src/integrations/registry.js";
import {
  createIntegrationApprovalHook,
  MANAGED_WRITE_ACTIONS,
} from "../../packages/kernel/src/hooks.js";

describe("integration native approval hook", () => {
  it("asks for managed writes but not reads", async () => {
    const request = vi.fn(async () => true);
    const hook = createIntegrationApprovalHook("/tmp/missing", request);
    await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_service", tool_input: { service: "notion", action: "create_page" }, session_id: "s" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_service", tool_input: { service: "stripe", action: "list_customers" }, session_id: "s" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the approval map aligned with registry risk metadata", () => {
    const writes = listServices().flatMap((service) => Object.entries(service.actions)
      .filter(([, action]) => action.risk === "write")
      .map(([action]) => `${service.id}/${action}`));
    expect([...MANAGED_WRITE_ACTIONS].sort()).toEqual(writes.sort());
  });

  it("intersects enabled local policy and explicit subagent frontmatter grants", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-mcp-hook-"));
    await mkdir(join(home, "system"));
    await writeFile(join(home, "system", "mcp-servers.json"), JSON.stringify({
      version: 1,
      servers: [{ id: "server-1", name: "Research", enabled: true, tools: [{ name: "search", enabled: true, approval: "allow" }] }],
    }));
    const hook = createIntegrationApprovalHook(home, vi.fn(async () => true), { researcher: ["Research"] });
    const allowed = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_custom_mcp_tool", tool_input: { server_id: "server-1", tool: "search" }, session_id: "s", agent_id: "researcher" });
    const denied = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_custom_mcp_tool", tool_input: { server_id: "server-1", tool: "search" }, session_id: "s", agent_id: "builder" });
    expect(allowed.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
