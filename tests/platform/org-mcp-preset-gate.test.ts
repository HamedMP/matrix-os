/**
 * Spec 2691 "Org scope": org policy also governs managed preset calls made
 * through Integrations, not only Matrix Core MCP tools.
 * Fault: an admin blocks a server in Connections and the member keeps calling
 * the same connection through `/api/integrations/call`.
 */
import { describe, expect, it, vi } from "vitest";
import { createOrgMcpPresetGate, OrgMcpPolicyDeniedError } from "../../packages/platform/src/org-mcp/preset-gate.js";

const preset = { id: "server-1", url: "https://mcp.granola.ai/mcp" };

function setup(evaluate: (input: { actorId: string; serverUrl: string; toolName: string }) => Promise<{ allowed: boolean }>) {
  const broker = {
    marker: "real",
    getPreset: vi.fn(async (_userId: string, presetId: string) => presetId === "granola" ? preset : null),
    callManagedPresetTool: vi.fn(async () => "called"),
    whoAmI() { return this.marker; },
  };
  const gate = createOrgMcpPresetGate({
    policy: { evaluate: vi.fn(evaluate) },
    resolveActorId: async userId => userId === "u_1" ? "user_clerk1" : null,
  });
  return { broker, gate, governed: gate.governBroker(broker) };
}
const call = { userId: "u_1", serverId: "server-1", presetId: "granola", toolName: "list_meetings", arguments: {} };

describe("org policy gate for managed preset calls", () => {
  it("refuses a managed preset tool the org blocks and never reaches the upstream", async () => {
    const seen: unknown[] = [];
    const { broker, governed } = setup(async input => { seen.push(input); return { allowed: false }; });
    await expect(governed.callManagedPresetTool(call)).rejects.toBeInstanceOf(OrgMcpPolicyDeniedError);
    expect(seen).toEqual([{ actorId: "user_clerk1", serverUrl: preset.url, toolName: "list_meetings" }]);
    expect(broker.callManagedPresetTool).not.toHaveBeenCalled();
  });

  it("passes allowed calls and every other broker method through unchanged", async () => {
    const { broker, governed } = setup(async () => ({ allowed: true }));
    await expect(governed.callManagedPresetTool(call)).resolves.toBe("called");
    expect(broker.callManagedPresetTool).toHaveBeenCalledWith(call);
    expect(governed.whoAmI()).toBe("real");
  });

  it("fails closed when policy cannot be read, the owner is unknown, or the server is not that preset", async () => {
    const failing = setup(async () => { throw new Error("pg: connection refused"); });
    await expect(failing.governed.callManagedPresetTool(call)).rejects.toBeInstanceOf(OrgMcpPolicyDeniedError);
    const allowed = setup(async () => ({ allowed: true }));
    await expect(allowed.governed.callManagedPresetTool({ ...call, userId: "u_unknown" })).rejects.toBeInstanceOf(OrgMcpPolicyDeniedError);
    await expect(allowed.governed.callManagedPresetTool({ ...call, serverId: "server-2" })).rejects.toBeInstanceOf(OrgMcpPolicyDeniedError);
    expect(failing.broker.callManagedPresetTool).not.toHaveBeenCalled();
    expect(allowed.broker.callManagedPresetTool).not.toHaveBeenCalled();
  });

  it("gates a preset broker that calls its provider directly, by action id", async () => {
    const { gate } = setup(async input => ({ allowed: input.toolName !== "create_invoice" }));
    const inner = { call: vi.fn(async () => "done"), listConnections: vi.fn(async () => []) };
    const governed = gate.governPresetBroker(inner, "https://api.bokio.se");
    await expect(governed.call({ userId: "u_1", service: "bokio", actionId: "list_invoices" })).resolves.toBe("done");
    await expect(governed.call({ userId: "u_1", service: "bokio", actionId: "create_invoice" })).rejects.toBeInstanceOf(OrgMcpPolicyDeniedError);
    expect(inner.call).toHaveBeenCalledTimes(1);
    expect(governed.listConnections).toBe(inner.listConnections);
  });
});
