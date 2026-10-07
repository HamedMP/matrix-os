import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it, vi } from "vitest";
import { createManagedOAuthPresetBroker } from "../../packages/platform/src/managed-oauth-preset-broker.js";
import { availableManagedActions, planManagedOAuthAction, supportedManagedActionParams } from "../../packages/platform/src/managed-oauth-presets.js";

function dependencies() {
  const row = { id: "owned-server", status: "ready", created_at: "2026-10-07", tools: [
    { name: "teams", inputSchema: { type: "object", properties: {} } },
    { name: "execute", inputSchema: { type: "object", properties: {
      method: {}, path: {}, team: {}, query: {}, body: {},
    } } },
  ] };
  return { row, broker: { getPreset: vi.fn(async (owner: string, preset: string) => owner === "owner" && preset === "loops" ? row : null),
    activatePreset: vi.fn(async () => row), ensurePreset: vi.fn(async () => row),
    callManagedPresetTool: vi.fn(async () => ({ success: true })), remove: vi.fn(),
  }, oauth: { start: vi.fn(async () => "https://loops.so/authorize") } };
}
describe("managed OAuth presets", () => {
  it("keeps disabled connections passive during inventory and catalog reads", async () => {
    const d = dependencies(); d.row.status = "disabled";
    const b = createManagedOAuthPresetBroker(d);
    expect((await b.listConnections("owner"))[0]?.status).toBe("disabled");
    expect(await b.listAvailableActions("owner", "loops")).toEqual([]);
    expect(await b.listAvailableActionParams("owner", "loops")).toBeNull();
    expect(d.broker.activatePreset).not.toHaveBeenCalled();
    await expect(b.call({ userId: "owner", service: { id: "loops" }, actionId: "list_teams" })).rejects.toThrow();
  });
  it("projects action IDs and parameters from one tools snapshot", async () => {
    const d = dependencies(); const b = createManagedOAuthPresetBroker(d);
    const compiler = vi.spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
    const snapshot = await b.listActionCapabilities!("owner", "loops");
    expect(snapshot?.list_mailing_lists).toEqual(["teamId"]);
    expect(d.broker.getPreset).toHaveBeenCalledTimes(1);
    expect(compiler.mock.calls.filter(([schema]) => d.row.tools.some(tool => tool.inputSchema === schema))).toHaveLength(2);
    compiler.mockRestore();
  });
  it("connects only a known official preset and denies an arbitrary endpoint", async () => {
    const d = dependencies(); const b = createManagedOAuthPresetBroker(d);
    await b.connect("owner", { id: "loops", url: "https://attacker.invalid" });
    expect(d.broker.ensurePreset).toHaveBeenCalledWith({ userId: "owner", presetId: "loops", name: "Loops", url: "https://mcp.loops.so/" });
    await expect(b.connect("owner", { id: "arbitrary" })).rejects.toThrow();
  });
  it("projects truthful capabilities and calls exact reviewed read operations", async () => {
    const d = dependencies(); const b = createManagedOAuthPresetBroker(d);
    expect(await b.listAvailableActions("owner", "loops")).toContain("list_teams");
    await b.call({ userId: "owner", service: { id: "loops" }, actionId: "list_mailing_lists", params: { teamId: "team-1" }, connectionId: "owned-server" });
    expect(d.broker.callManagedPresetTool).toHaveBeenCalledWith({ userId: "owner", serverId: "owned-server", presetId: "loops", toolName: "execute", arguments: { method: "GET", path: "/v1/lists", team: "team-1" } });
    await expect(b.call({ userId: "owner", service: { id: "loops" }, actionId: "list_teams", connectionId: "foreign" })).rejects.toThrow();
    await expect(b.call({ userId: "foreign", service: { id: "loops" }, actionId: "list_teams" })).rejects.toThrow();
  });
  it("never forwards caller method, paths, secret headers, or code to a meta-tool", () => {
    const d = dependencies();
    for (const params of [{ method: "POST" }, { path: "/v1/transactional" }, { headers: {} }, { code: "send()" }]) {
      expect(() => planManagedOAuthAction("loops", "list_mailing_lists", params, d.row.tools)).toThrow();
    }
    expect(() => planManagedOAuthAction("loops", "send_email", {}, d.row.tools)).toThrow();
  });
  it("uses the discovered lemlist parameter spelling and refuses absent tool schemas", () => {
    const tools = [{ name: "get_campaign_details", inputSchema: { properties: { campaign_id: {} } } }];
    expect(planManagedOAuthAction("lemlist", "get_campaign", { campaignId: "campaign1" }, tools)).toEqual({ toolName: "get_campaign_details", arguments: { campaign_id: "campaign1" } });
    expect(() => planManagedOAuthAction("lemlist", "get_campaign", { campaignId: "campaign1" }, [])).toThrow();
  });
  it.each([
    { properties: { method: { const: "POST" }, path: { type: "string" } } },
    { properties: { method: { enum: ["GET"] }, path: { enum: ["/v1/contacts/create"] } } },
    { properties: { method: {}, path: {}, body: {} }, required: ["body"] },
    { type: "string", properties: { method: {}, path: {} } },
  ])("does not advertise or execute incompatible fixed read operations %j", (inputSchema) => {
    const tools = [{ name: "execute", inputSchema }];
    expect(availableManagedActions("loops", tools)).not.toContain("list_mailing_lists");
    expect(() => planManagedOAuthAction("loops", "list_mailing_lists", {}, tools)).toThrow();
  });
  it("requires a valid query-object mapping before advertising contact search", () => {
    const tools = [{ name: "execute", inputSchema: { type: "object", properties: { method: { enum: ["GET"] }, path: {}, query: { type: "string" } } } }];
    expect(availableManagedActions("loops", tools)).toContain("list_mailing_lists");
    expect(availableManagedActions("loops", tools)).not.toContain("find_contact");
    expect(() => planManagedOAuthAction("loops", "find_contact", { email: "person@example.test" }, tools)).toThrow();
  });
  it("chooses a usable alternative tool and preserves its actual parameter names", () => {
    const tools = [
      { name: "get_campaigns", inputSchema: { type: "object", properties: { secret: { type: "string" } }, required: ["secret"] } },
      { name: "list_campaigns", inputSchema: { type: "object", properties: {} } },
      { name: "get_campaign_details", inputSchema: { type: "object", properties: { campaignId: { type: "number" }, campaign_id: { type: "string" } }, required: ["campaign_id"] } },
    ];
    expect(availableManagedActions("lemlist", tools)).toContain("list_campaigns");
    expect(planManagedOAuthAction("lemlist", "list_campaigns", {}, tools).toolName).toBe("list_campaigns");
    expect(planManagedOAuthAction("lemlist", "get_campaign", { campaignId: "campaign1" }, tools).arguments).toEqual({ campaign_id: "campaign1" });
  });
  it("rejects additional provider-required fields instead of exposing a broken capability", () => {
    const tools = [{ name: "get_campaign_details", inputSchema: { type: "object", properties: { campaign_id: { type: "string" }, workspace_secret: { type: "string" } }, required: ["campaign_id", "workspace_secret"] } }];
    expect(availableManagedActions("lemlist", tools)).not.toContain("get_campaign");
    expect(() => planManagedOAuthAction("lemlist", "get_campaign", { campaignId: "campaign1" }, tools)).toThrow();
  });
  it("honors exact provider field constraints on actual call arguments", () => {
    const tools = [{ name: "get_campaign_details", inputSchema: { type: "object", properties: { campaign_id: { type: "string", minLength: 5, maxLength: 20 } }, required: ["campaign_id"], additionalProperties: false } }];
    expect(planManagedOAuthAction("lemlist", "get_campaign", { campaignId: "campaign1" }, tools).arguments).toEqual({ campaign_id: "campaign1" });
    expect(() => planManagedOAuthAction("lemlist", "get_campaign", { campaignId: "x" }, tools)).toThrow();
  });
  it("only advertises optional parameters with a compatible discovered schema", () => {
    const tools = [{ name: "execute", inputSchema: { type: "object", properties: { method: {}, path: {}, team: { type: "number" } } } }];
    expect(availableManagedActions("loops", tools)).toContain("list_mailing_lists");
    expect(supportedManagedActionParams("loops", "list_mailing_lists", tools)).toEqual([]);
    expect(() => planManagedOAuthAction("loops", "list_mailing_lists", { teamId: "team-1" }, tools)).toThrow();
  });
});
