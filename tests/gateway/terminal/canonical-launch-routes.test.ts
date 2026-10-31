import { describe, expect, it, vi } from "vitest";
import { createTerminalWorkspaceRoutes } from "../../../packages/gateway/src/shell/workspace-routes.js";
const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const principal = { userId: "actual-clerk-owner", source: "jwt" as const };
function fixture() {
  const tab = { id: "tt_0123456789abcdef0123456789abcdef", workspaceId, name: "Hermes", cwd: "", accessScope: "owner", status: "running" };
  const runtime = { listWorkspaces: vi.fn(async () => []), ensureWorkspace: vi.fn(), createTab: vi.fn(async () => tab), deletionImpact: vi.fn(), deleteWorkspace: vi.fn() };
  const launch = vi.fn(async () => tab);
  const app = createTerminalWorkspaceRoutes({ runtime: runtime as never, getPrincipal: () => principal, terminalOwnerIds: [principal.userId], managedLaunch: { launch } } as never);
  return { app, runtime, launch };
}
describe("authenticated canonical native Terminal selection", () => {
  it.each(["claude", "codex", "hermes", "opencode", "pi"])("routes explicit %s selection with the actual principal through private admission", async harness => {
    const f = fixture();
    const response = await f.app.request(`/workspaces/${workspaceId}/tabs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: harness, cwd: "", managedLaunch: { harness } }) });
    expect(response.status).toBe(201);
    expect(f.launch).toHaveBeenCalledWith(principal, workspaceId, expect.objectContaining({ managedLaunch: { harness } }));
    expect(f.runtime.createTab).not.toHaveBeenCalled();
  });
  it("arbitrary command and agent labels stay ordinary unproved Terminal creation", async () => {
    const f = fixture();
    const response = await f.app.request(`/workspaces/${workspaceId}/tabs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Claude", cwd: "", command: ["claude", "--dangerously-skip-permissions"], agent: { providerId: "claude" } }) });
    expect(response.status).toBe(201); expect(f.launch).not.toHaveBeenCalled(); expect(f.runtime.createTab).toHaveBeenCalledOnce();
  });
});
it("Preview preserves ordinary native selection under resource-owner access without creating source authority", async () => {
  const runtime = { listWorkspaces: vi.fn(async () => []), ensureWorkspace: vi.fn(), createTab: vi.fn(async () => ({ id: "tt_" + "a".repeat(32) })), deletionImpact: vi.fn(), deleteWorkspace: vi.fn() };
  const launch = vi.fn();
  const app = createTerminalWorkspaceRoutes({ runtime: runtime as never, getPrincipal: () => principal, terminalOwnerIds: ["preview_resource_owner"], getPreviewTerminalOwner: () => "preview_resource_owner", managedLaunch: { launch } as never });
  const response = await app.request(`/workspaces/${workspaceId}/tabs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Hermes", cwd: "", managedLaunch: { harness: "hermes" } }) });
  expect(response.status).toBe(201); expect(launch).not.toHaveBeenCalled();
  expect(runtime.createTab).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ command: ["sh", "-lc", "hermes"] }));
});
