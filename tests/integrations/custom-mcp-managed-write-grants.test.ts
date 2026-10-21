import { describe, expect, it, vi } from "vitest";
import { CustomMcpBroker, type CustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { encryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { RemoteMcpClient } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import type { CustomMcpServerProjection } from "../../packages/gateway/src/integrations/custom-mcp/types.js";
import { MANAGED_INTEGRATIONS } from "../../packages/contracts/src/managed-integrations.js";

function fixture(presetId = "posthog_oauth", toolName = "insight-update", oauth: CustomMcpCredential["oauth"] = { accessToken: "token", managedWriteAccess: true, grantedScopes: ["insight:write", "mcp"] }) {
  const key = Buffer.alloc(32, 20); const id = "server";
  const tool = { name: toolName, enabled: true, approval: "allow" as const };
  const projection: CustomMcpServerProjection = { id, name: "Fixture", url: "https://mcp.posthog.com/mcp?tools=projects-get,project-get,insights-list,insight-get", authMode: "oauth", enabled: true, revision: 1, tools: [tool] };
  const row = { id, user_id: "owner", preset_id: presetId, auth_mode: "oauth", url: projection.url, enabled: true, status: "ready", revision: 1, encrypted_credentials: "", enforcement_projection: [tool] };
  const set = (value: CustomMcpCredential["oauth"]) => { row.encrypted_credentials = encryptCustomMcpCredential({ oauth: value }, key, { userId: "owner", serverId: id }); };
  set(oauth);
  const update = vi.fn(async (_id, _owner, revision, patch) => {
    if (row.revision !== revision) return null;
    Object.assign(row, patch, { revision: revision + 1 });
    return { id, name: "Fixture", url: row.url, authMode: "oauth", enabled: row.enabled, revision: row.revision, status: row.status, tools: [tool] };
  });
  const db = { getCustomMcpServerForBroker: vi.fn(async () => ({ ...row })), getCustomMcpPresetForBroker: vi.fn(async () => ({ ...row })), updateCustomMcpServer: update } as unknown as PlatformDb;
  const remote = vi.fn().mockResolvedValue({ ok: true });
  const resolve = vi.fn(async () => "Bearer token");
  const validateUrl = vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const }));
  const broker = new CustomMcpBroker({ db, encryptionKey: key, projection: { upsert: vi.fn(), remove: vi.fn(), read: vi.fn(async () => projection) }, client: { callTool: remote } as unknown as RemoteMcpClient, resolveOAuthAuthorization: resolve, validateUrl });
  return { broker, row, set, remote, resolve, update, validateUrl, input: { userId: "owner", serverId: id, presetId, toolName, arguments: { id: "insight", name: "Chart" } } };
}

describe("managed MCP final write grant enforcement", () => {
  it.each([{}, { accessToken: "token", managedWriteAccess: true, grantedScopes: ["insight:read"] }, { accessToken: "token", managedWriteAccess: false, grantedScopes: ["insight:write"] }, { accessToken: "token", managedWriteAccess: true, grantedScopes: ["insight:write"], state: "pending" }])("denies legacy, insufficient or pending grants before token lookup (%#)", async oauth => {
    const f = fixture("posthog_oauth", "insight-update", oauth);
    await expect(f.broker.callManagedPresetTool(f.input)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.remote).not.toHaveBeenCalled();
  });
  it("reports proven read scopes without granting write opt-in", async () => {
    const f = fixture("posthog_oauth", "insight-update", { accessToken: "token", grantedScopes: ["insight:read"] });
    expect(await f.broker.getPresetWriteAuthorization("owner", "posthog_oauth")).toEqual({ enabled: false, scopes: ["insight:read"] });
    await expect(f.broker.callManagedPresetTool(f.input)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.remote).not.toHaveBeenCalled();
  });
  it("allows an explicitly authorized current grant", async () => {
    const f = fixture(); await expect(f.broker.callManagedPresetTool(f.input)).resolves.toEqual({ ok: true });
    expect(f.remote).toHaveBeenCalledOnce();
  });
  it("rechecks scopes after token refresh narrows the current grant without a policy revision change", async () => {
    const f = fixture(); f.resolve.mockImplementationOnce(async () => { f.set({ accessToken: "fresh", managedWriteAccess: true, grantedScopes: ["insight:read"] }); return "Bearer fresh"; });
    await expect(f.broker.callManagedPresetTool(f.input)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.remote).not.toHaveBeenCalled();
  });
  it("distinguishes shared Loops GET from POST independently of caller risk", async () => {
    const f = fixture("loops", "execute", { accessToken: "token", grantedScopes: ["mcp"] });
    await expect(f.broker.callManagedPresetTool({ ...f.input, arguments: { method: "GET", path: "/v1/lists" } })).resolves.toEqual({ ok: true });
    await expect(f.broker.callManagedPresetTool({ ...f.input, arguments: { method: "POST", path: "/v1/contacts/properties" } })).rejects.toMatchObject({ code: "forbidden" });
    expect(f.remote).toHaveBeenCalledOnce();
  });
  it("still requires new explicit consent when the upstream write has no separate scope", async () => {
    const f = fixture("lemlist", "create_campaign_with_sequence", { accessToken: "token", grantedScopes: [] });
    await expect(f.broker.callManagedPresetTool(f.input)).rejects.toMatchObject({ code: "forbidden" });
    f.set({ accessToken: "token", managedWriteAccess: true, grantedScopes: [] });
    await expect(f.broker.callManagedPresetTool(f.input)).resolves.toEqual({ ok: true });
  });
  it("updates only the compiled preset endpoint during explicit reconnect and disables old tool authority", async () => {
    const f = fixture();
    await f.broker.getPreset("owner", "posthog_oauth");
    expect(f.update).not.toHaveBeenCalled();
    await f.broker.ensurePreset({ userId: "owner", presetId: "posthog_oauth", name: "PostHog", url: MANAGED_INTEGRATIONS.posthog_oauth!.url });
    expect(f.update).toHaveBeenCalledWith("server", "owner", 1, { url: MANAGED_INTEGRATIONS.posthog_oauth!.url, enabled: false, status: "auth_required" });
    expect(f.row.revision).toBe(2);
  });
});
