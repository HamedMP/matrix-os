import { describe, expect, it, vi } from "vitest";
import { MANAGED_INTEGRATIONS, managedToolWriteRequirements } from "../../packages/contracts/src/managed-integrations.js";
import { availableManagedActions, planManagedOAuthAction } from "../../packages/platform/src/managed-oauth-presets.js";
import { createManagedOAuthPresetBroker } from "../../packages/platform/src/managed-oauth-preset-broker.js";
import { projectIntegrationCatalog } from "../../packages/gateway/src/integrations/catalog-projection.js";
import { MANAGED_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-managed.js";

const authorization = { enabled: true, scopes: ["insight:write", "mcp"] };
const tools = {
  posthog_oauth: [{ name: "insight-update", enabled: true, inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["id"], additionalProperties: false } }],
  loops: [{ name: "execute", enabled: true, inputSchema: { type: "object", properties: { method: { enum: ["GET", "POST"] }, path: { type: "string" }, team: { type: "string" }, body: { type: "object", properties: { name: { type: "string" }, type: { enum: ["string", "number", "boolean", "date"] } }, required: ["name", "type"], additionalProperties: false } }, required: ["method", "path"], additionalProperties: false } }],
  lemlist: [{ name: "create_campaign_with_sequence", enabled: true, inputSchema: { type: "object", properties: { name: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, timezone: { type: "string" } }, required: ["name"], additionalProperties: false } }],
};
const cases = [
  ["posthog_oauth", "update_insight_metadata", { insightId: "abc123", name: "Activation", description: "Saved chart" }, { toolName: "insight-update", arguments: { id: "abc123", name: "Activation", description: "Saved chart" } }],
  ["loops", "create_contact_property", { name: "integrationSource", type: "string", teamId: "team-1" }, { toolName: "execute", arguments: { method: "POST", path: "/v1/contacts/properties", body: { name: "integrationSource", type: "string" }, team: "team-1" } }],
  ["lemlist", "create_draft_campaign", { name: "Planning" }, { toolName: "create_campaign_with_sequence", arguments: { name: "Planning" } }],
] as const;

describe("managed OAuth bounded writes", () => {
  it.each(cases)("requires explicit current write opt-in for %s/%s", (service, action, params, expected) => {
    expect(MANAGED_SERVICE_REGISTRY[service]!.actions[action]!.risk).toBe("write");
    expect(availableManagedActions(service, tools[service])).not.toContain(action);
    expect(() => planManagedOAuthAction(service, action, params, tools[service])).toThrow();
    expect(planManagedOAuthAction(service, action, params, tools[service], authorization)).toEqual(expected);
    expect(availableManagedActions(service, tools[service], authorization)).toContain(action);
    expect(availableManagedActions(service, tools[service].map(tool => ({ ...tool, enabled: false })), authorization)).not.toContain(action);
    expect(() => planManagedOAuthAction(service, action, { ...params, subject: "send" }, tools[service], authorization)).toThrow();
  });
  it("derives dispatch write requirements independently from caller claims", () => {
    expect(managedToolWriteRequirements("loops", "execute", { method: "POST", path: "/v1/contacts/properties" })).toEqual({ write: true, requiredScopes: ["mcp"] });
    expect(managedToolWriteRequirements("loops", "execute", { method: "DELETE" })).toEqual({ write: true, requiredScopes: ["mcp"] });
    expect(managedToolWriteRequirements("loops", "execute", { method: "GET", path: "/v1/lists" })).toEqual({ write: false, requiredScopes: [] });
    expect(managedToolWriteRequirements("posthog_oauth", "insight-update", {})).toEqual({ write: true, requiredScopes: ["insight:write"] });
    expect(managedToolWriteRequirements("lemlist", "create_campaign_with_sequence", {})).toEqual({ write: true, requiredScopes: [] });
    expect(managedToolWriteRequirements("posthog_oauth", "projects-get", {})).toEqual({ write: false, requiredScopes: [] });
    expect(managedToolWriteRequirements("posthog_oauth", "unknown-tool", {})).toEqual({ write: true, requiredScopes: [] });
    expect(managedToolWriteRequirements("loops", "execute")).toEqual({ write: true, requiredScopes: ["mcp"] });
    expect(managedToolWriteRequirements("granola", "list_notes", {})).toEqual({ write: false, requiredScopes: [] });
  });
  it("keeps all new managed writes outside scoped read catalogs", async () => {
    const result = await projectIntegrationCatalog({ services: Object.values(MANAGED_SERVICE_REGISTRY), uid: "owner", capabilityIdentityFailed: false, authoritative: false, readOnly: true, presetBroker: {}, logoUrl: service => service.logoUrl });
    for (const [service, action] of cases) expect(result.find(row => row.id === service)!.actions).not.toHaveProperty(action);
  });
  it("requires actual PostHog and Loops granted scopes", () => {
    for (const service of ["posthog_oauth", "loops"] as const) {
      expect(availableManagedActions(service, tools[service], { enabled: true, scopes: [] })).not.toContain(cases.find(row => row[0] === service)![1]);
    }
    expect(MANAGED_INTEGRATIONS.posthog_oauth!.scopes).not.toContain("insight:write");
    expect(MANAGED_INTEGRATIONS.posthog_oauth!.writeScopes).toContain("insight:write");
  });
  it.each([
    ["posthog_oauth", "update_insight_metadata", { insightId: "abc123" }],
    ["posthog_oauth", "update_insight_metadata", { insightId: " abc123 ", name: "Activation" }],
    ["posthog_oauth", "update_insight_metadata", { insightId: "abc123", description: "x".repeat(401) }],
    ["posthog_oauth", "update_insight_metadata", { insightId: "abc123", name: " " }],
    ["loops", "create_contact_property", { name: "integrationSource", type: "object" }],
    ["loops", "create_contact_property", { name: "../secret", type: "string" }],
    ["loops", "create_contact_property", { name: "integrationSource", type: "string", body: { anything: true } }],
    ["lemlist", "create_draft_campaign", { name: "x".repeat(201) }],
    ["lemlist", "create_draft_campaign", { name: "Planning", body: "Send" }],
  ] as const)("rejects unsafe %s/%s inputs", (service, action, params) => {
    expect(() => planManagedOAuthAction(service, action, params, tools[service], authorization)).toThrow();
  });
  it("requests write scopes only on an explicit connector reconnect", async () => {
    const row = { id: "server", status: "ready", created_at: "2026-10-18", tools: tools.posthog_oauth };
    const broker = { getPreset: vi.fn(async () => row), ensurePreset: vi.fn(async () => row), activatePreset: vi.fn(), remove: vi.fn(), callManagedPresetTool: vi.fn() };
    const oauth = { start: vi.fn(async () => "https://auth.example") };
    const b = createManagedOAuthPresetBroker({ broker, oauth });
    await b.listAvailableActions("owner", "posthog_oauth");
    expect(oauth.start).not.toHaveBeenCalled();
    await b.connect("owner", { id: "posthog_oauth", url: "https://evil.example" });
    expect(broker.ensurePreset).toHaveBeenCalledWith(expect.objectContaining({ url: MANAGED_INTEGRATIONS.posthog_oauth!.url }));
    expect(oauth.start).toHaveBeenCalledWith("owner", "server", { scopes: ["project:read", "organization:read", "insight:read", "insight:write"], managedWriteAccess: true });
  });
  it("requires the full discovered provider schema to accept reviewed bodies", () => {
    const incompatible = structuredClone(tools.loops);
    incompatible[0]!.inputSchema.properties.body.properties.type.enum = ["invalid"];
    expect(availableManagedActions("loops", incompatible, authorization)).not.toContain("create_contact_property");
  });
  it("keeps broker reads working but hides and denies legacy grants' writes", async () => {
    const row = { id: "server", status: "ready", created_at: "2026-10-18", tools: tools.loops };
    const broker = { getPreset: vi.fn(async () => row), ensurePreset: vi.fn(async () => row), activatePreset: vi.fn(), remove: vi.fn(), callManagedPresetTool: vi.fn() };
    const oauth = { start: vi.fn(async () => "https://auth.example") };
    const b = createManagedOAuthPresetBroker({ broker, oauth });
    expect(await b.listAvailableActions("owner", "loops")).toContain("list_mailing_lists");
    expect(await b.listAvailableActions("owner", "loops")).not.toContain("create_contact_property");
    await expect(b.call({ userId: "owner", service: { id: "loops" }, actionId: "create_contact_property", params: { name: "integrationSource", type: "string" } })).rejects.toThrow();
    expect(broker.callManagedPresetTool).not.toHaveBeenCalled();
    expect(broker.activatePreset).not.toHaveBeenCalled();
  });
  it("reports actual scopes and disconnects only the selected owner connection", async () => {
    const row = { id: "server", status: "ready", created_at: "2026-10-18", tools: tools.loops };
    const broker = { getPreset: vi.fn(async (_owner: string, service: string) => service === "loops" ? row : null), getPresetWriteAuthorization: vi.fn(async () => ({ enabled: false, scopes: ["actual-grant-scope"] })), ensurePreset: vi.fn(async () => row), activatePreset: vi.fn(), remove: vi.fn(), callManagedPresetTool: vi.fn() };
    const oauth = { start: vi.fn(async () => "https://auth.example") };
    const b = createManagedOAuthPresetBroker({ broker, oauth });
    expect((await b.listConnections("owner"))[0]!.scopes).toEqual(["actual-grant-scope"]);
    expect(await b.disconnect("owner", "foreign")).toBe(false);
    expect(broker.remove).not.toHaveBeenCalled();
    expect(await b.disconnect("owner", "server")).toBe(true);
    expect(broker.remove).toHaveBeenCalledWith("owner", "server");
    expect(await b.listAvailableActions("owner", "unknown")).toBeNull();
    expect(await b.listActionCapabilities!("owner", "unknown")).toEqual({});
    expect(await b.listAvailableActionParams("owner", "unknown")).toBeNull();
  });
  it("sends bounded writes only after retrieving current grant authorization", async () => {
    const row = { id: "server", status: "ready", created_at: "2026-10-18", tools: tools.loops };
    const broker = { getPreset: vi.fn(async () => row), getPresetWriteAuthorization: vi.fn(async () => authorization), ensurePreset: vi.fn(async () => row), activatePreset: vi.fn(), remove: vi.fn(), callManagedPresetTool: vi.fn() };
    const oauth = { start: vi.fn(async () => "https://auth.example") };
    const b = createManagedOAuthPresetBroker({ broker, oauth });
    expect(await b.listAvailableActions("owner", "loops")).toContain("create_contact_property");
    await b.call({ userId: "owner", service: { id: "loops" }, actionId: "create_contact_property", params: { name: "integrationSource", type: "string" } });
    expect(broker.callManagedPresetTool).toHaveBeenCalledWith({ userId: "owner", serverId: "server", presetId: "loops", toolName: "execute", arguments: { method: "POST", path: "/v1/contacts/properties", body: { name: "integrationSource", type: "string" } } });
    await b.connect("owner", { id: "loops" });
    expect(oauth.start).toHaveBeenCalledWith("owner", "server", { scopes: ["mcp"], managedWriteAccess: true });
    broker.getPresetWriteAuthorization.mockResolvedValueOnce({ enabled: false, scopes: [] });
    await expect(b.call({ userId: "owner", service: { id: "loops" }, actionId: "create_contact_property", params: { name: "integrationSource", type: "string" } })).rejects.toThrow();
    expect(broker.callManagedPresetTool).toHaveBeenCalledTimes(1);
  });
});
