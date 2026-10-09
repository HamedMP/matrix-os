import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listServices } from "../../packages/gateway/src/integrations/registry.js";
import {
  createIntegrationApprovalHook,
  MANAGED_WRITE_ACTIONS,
} from "../../packages/kernel/src/hooks.js";

describe("integration native approval hook", () => {
  const expandedWrites = [
    ["discord", "send_message"],
    ["discord_bot", "send_message"],
    ["google_sheets", "add_sheet"], ["google_sheets", "append_values"],
    ["google_sheets", "create_spreadsheet"], ["google_sheets", "update_values"],
    ["todoist", "complete_task"], ["todoist", "create_task"], ["todoist", "update_task"],
    ["zendesk", "update_ticket"],
  ] as const;

  it.each(expandedWrites)("requires native consent for %s/%s and honors both decisions", async (service, action) => {
    const input = {
      hook_event_name: "PreToolUse" as const, tool_name: "mcp__matrix-os-ipc__call_service",
      tool_input: { service, action, params: { reviewed: "exact action arguments" } }, session_id: "s",
    };
    const request = vi.fn(async () => false);
    const hook = createIntegrationApprovalHook("/tmp/missing", request);
    const denied = await hook(input);
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(request).toHaveBeenCalledExactlyOnceWith(input.tool_name, input.tool_input);
    request.mockResolvedValueOnce(true);
    expect(await hook(input)).toEqual({});
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(input.tool_name, input.tool_input);
  });

  it.each([
    ["discord", "list_servers"], ["discord_bot", "list_channels"], ["discord_bot", "list_messages"],
    ["google_sheets", "get_values"], ["todoist", "get_task"], ["zendesk", "get_ticket"],
  ])("permits the corresponding %s/%s read without asking for write consent", async (service, action) => {
    const request = vi.fn(async () => false);
    const hook = createIntegrationApprovalHook("/tmp/missing", request);
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_service",
      tool_input: { service, action }, session_id: "s" })).toEqual({});
    expect(request).not.toHaveBeenCalled();
    expect(listServices().find(item => item.id === service)?.actions[action]?.risk).toBe("read");
  });
  it("requires approval for Gmail label writes but not mailbox history reads", async () => {
    const request = vi.fn(async () => false);
    const hook = createIntegrationApprovalHook("/tmp/missing", request);
    for (const action of ["create_label", "modify_message"]) {
      const result = await hook({
        hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_service",
        tool_input: { service: "gmail", action }, session_id: "s",
      });
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
    const read = await hook({
      hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_service",
      tool_input: { service: "gmail", action: "list_history" }, session_id: "s",
    });
    expect(read.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("asks for managed writes but not reads", async () => {
    const request = vi.fn(async () => true);
    const hook = createIntegrationApprovalHook("/tmp/missing", request);
    await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_service", tool_input: { service: "notion", action: "create_page" }, session_id: "s" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_service", tool_input: { service: "stripe", action: "list_customers" }, session_id: "s" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("asks for native approval before publishing or replying on X", async () => {
    const request = vi.fn(async () => true);
    const hook = createIntegrationApprovalHook("/tmp/missing", request);

    await hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__matrix-os-ipc__call_service",
      tool_input: {
        service: "twitter",
        action: "create_post",
        params: { text: "Approved post" },
      },
      session_id: "s",
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "mcp__matrix-os-ipc__call_service",
      expect.objectContaining({ service: "twitter", action: "create_post" }),
    );
  });

  it("keeps the approval map aligned with registry risk metadata", () => {
    const writes = listServices().flatMap((service) => Object.entries(service.actions)
      .filter(([, action]) => action.risk === "write")
      .map(([action]) => `${service.id}/${action}`));
    expect([...MANAGED_WRITE_ACTIONS].sort()).toEqual(writes.sort());
  });

  it("intersects enabled local policy and explicit subagent frontmatter grants", async (context) => {
    const home = await mkdtemp(join(tmpdir(), "matrix-mcp-hook-"));
    context.onTestFinished(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, "system"));
    await writeFile(join(home, "system", "mcp-servers.json"), JSON.stringify({
      version: 1,
      servers: [{ id: "server-1", name: "Research", enabled: true, tools: [{ name: "search", enabled: true, approval: "allow" }] }],
    }));
    const hook = createIntegrationApprovalHook(home, vi.fn(async () => true), { researcher: ["Research"] });
    const allowed = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_custom_mcp_tool", tool_input: { server_id: "server-1", tool: "search" }, session_id: "s", agent_id: "runtime-123", agent_type: "researcher" });
    const denied = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__matrix-os-ipc__call_custom_mcp_tool", tool_input: { server_id: "server-1", tool: "search" }, session_id: "s", agent_id: "runtime-456", agent_type: "builder" });
    expect(allowed.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
