import { describe, expect, it, vi } from "vitest";
import { TASK_CRM_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/task-crm-writes.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction, ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const baseId = "app1234567890ABCD";
const tableId = "tbl1234567890ABCD";
const recordId = "rec1234567890ABCD";
const cases: Array<{
  service: string; action: string; method: string; url: string;
  params: Record<string, unknown>; body: Record<string, unknown>;
}> = [
  { service: "asana", action: "create_task", method: "POST", url: "https://app.asana.com/api/1.0/tasks",
    params: { workspaceId: "123", name: "Plan", notes: "Notes", dueOn: "2026-10-20", projectIds: ["456"] },
    body: { data: { workspace: "123", name: "Plan", notes: "Notes", due_on: "2026-10-20", projects: ["456"] } } },
  { service: "asana", action: "update_task", method: "PUT", url: "https://app.asana.com/api/1.0/tasks/123",
    params: { taskId: "123", completed: false, notes: "", dueOn: null },
    body: { data: { completed: false, notes: "", due_on: null } } },
  { service: "airtable", action: "create_record", method: "POST", url: `https://api.airtable.com/v0/${baseId}/${tableId}`,
    params: { baseId, tableId, fields: { Name: "Plan", Done: false, Count: 0, Tags: ["One"] } },
    body: { fields: { Name: "Plan", Done: false, Count: 0, Tags: ["One"] }, typecast: false } },
  { service: "airtable", action: "update_record", method: "PATCH", url: `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`,
    params: { baseId, tableId, recordId, fields: { Done: true, Name: null } },
    body: { fields: { Done: true, Name: null }, typecast: false } },
  { service: "clickup", action: "create_task", method: "POST", url: "https://api.clickup.com/api/v2/list/123/task",
    params: { listId: "123", name: "Plan", description: "Notes", priority: 2, dueDate: 1792454400000 },
    body: { name: "Plan", description: "Notes", priority: 2, due_date: 1792454400000, check_required_custom_fields: true } },
  { service: "clickup", action: "update_task", method: "PUT", url: "https://api.clickup.com/api/v2/task/abc123",
    params: { taskId: "abc123", status: "in progress", description: " " },
    body: { status: "in progress", description: " " } },
  { service: "hubspot", action: "create_contact", method: "POST", url: "https://api.hubapi.com/crm/v3/objects/contacts",
    params: { properties: { email: "owner@example.com", firstname: "Alex" } },
    body: { properties: { email: "owner@example.com", firstname: "Alex" } } },
  { service: "hubspot", action: "update_contact", method: "PATCH", url: "https://api.hubapi.com/crm/v3/objects/contacts/123",
    params: { contactId: "123", properties: { lastname: "" } }, body: { properties: { lastname: "" } } },
  { service: "hubspot", action: "create_company", method: "POST", url: "https://api.hubapi.com/crm/v3/objects/companies",
    params: { properties: { name: "Example", domain: "example.com" } }, body: { properties: { name: "Example", domain: "example.com" } } },
  { service: "hubspot", action: "update_company", method: "PATCH", url: "https://api.hubapi.com/crm/v3/objects/companies/123",
    params: { companyId: "123", properties: { description: "Updated" } }, body: { properties: { description: "Updated" } } },
  { service: "hubspot", action: "create_deal", method: "POST", url: "https://api.hubapi.com/crm/v3/objects/deals",
    params: { properties: { dealname: "Example", pipeline: "default", dealstage: "qualifiedtobuy", amount: "42.50" } },
    body: { properties: { dealname: "Example", pipeline: "default", dealstage: "qualifiedtobuy", amount: "42.50" } } },
  { service: "hubspot", action: "update_deal", method: "PATCH", url: "https://api.hubapi.com/crm/v3/objects/deals/123",
    params: { dealId: "123", properties: { amount: "0" } }, body: { properties: { amount: "0" } } },
];
const definition = (service: string): ServiceDefinition => ({ id: service, name: service, category: "productivity", connectorKind: "pipedream", pipedreamApp: service, icon: "puzzle", logoUrl: "", actions: TASK_CRM_WRITE_ACTIONS[service] });
const action = (service: string, id: string): ServiceAction => TASK_CRM_WRITE_ACTIONS[service][id];

describe("task and CRM managed writes", () => {
  it("exports only reviewed actions for four services", () => {
    expect(Object.keys(TASK_CRM_WRITE_ACTIONS).sort()).toEqual(["airtable", "asana", "clickup", "hubspot"]);
    expect(Object.values(TASK_CRM_WRITE_ACTIONS).flatMap(Object.keys)).toHaveLength(cases.length);
  });
  it.each(cases)("validates and maps $service/$action through the selected account", async (example) => {
    const def = action(example.service, example.action);
    expect(def.risk).toBe("write");
    expect(validateActionParams(def, example.params)).toEqual({ valid: true });
    expect(def.directApi?.method).toBe(example.method);
    const proxies = { proxyPost: vi.fn().mockResolvedValue({ id: "created" }), proxyPut: vi.fn().mockResolvedValue({ id: "updated" }), proxyPatch: vi.fn().mockResolvedValue({ id: "updated" }), runAction: vi.fn() };
    await executeIntegrationAction({ pipedream: proxies as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "selected-account" }, def: definition(example.service),
      actionDef: { ...def, componentKey: "unreviewed-component" }, serviceId: example.service, actionId: example.action, params: example.params });
    const method = example.method === "POST" ? proxies.proxyPost : example.method === "PUT" ? proxies.proxyPut : proxies.proxyPatch;
    expect(method).toHaveBeenCalledExactlyOnceWith({ externalUserId: "owner", accountId: "selected-account", url: example.url, body: example.body });
    expect(proxies.runAction).not.toHaveBeenCalled();
  });
  it.each(cases)("rejects $service/$action account, host, and unknown payload overrides before execution", async (example) => {
    const proxyPost = vi.fn(); const proxyPut = vi.fn(); const proxyPatch = vi.fn();
    for (const extra of [{ accountId: "other" }, { url: "https://example.com" }, { externalUserId: "other" }, { unknown: true }]) {
      await expect(executeIntegrationAction({ pipedream: { proxyPost, proxyPut, proxyPatch } as unknown as PipedreamConnectClient,
        externalUserId: "owner", connection: { pipedream_account_id: "selected-account" }, def: definition(example.service),
        actionDef: action(example.service, example.action), serviceId: example.service, actionId: example.action, params: { ...example.params, ...extra } })).rejects.toThrow("Invalid action parameters");
    }
    expect(proxyPost).not.toHaveBeenCalled(); expect(proxyPut).not.toHaveBeenCalled(); expect(proxyPatch).not.toHaveBeenCalled();
  });
  it.each([
    ["asana", "create_task", { name: "Plan" }],
    ["asana", "create_task", { name: " ", workspaceId: "123" }],
    ["asana", "create_task", { name: "x".repeat(501), workspaceId: "123" }],
    ["asana", "create_task", { name: "Plan", workspaceId: "../other" }],
    ["asana", "create_task", { name: "Plan", workspaceId: "123", projectIds: Array(21).fill("456") }],
    ["asana", "update_task", { taskId: "123" }],
    ["asana", "update_task", { taskId: "123", name: undefined }],
    ["asana", "update_task", { taskId: "123", dueOn: "2026-02-30" }],
    ["asana", "update_task", { taskId: "123", notes: "x".repeat(10001) }],
    ["clickup", "create_task", { listId: "123", name: "Plan", priority: 0 }],
    ["clickup", "create_task", { listId: "123", name: "Plan", dueDate: -1 }],
    ["clickup", "create_task", { listId: "123", name: "Plan", dueDate: 1.5 }],
    ["clickup", "create_task", { listId: "123", name: "Plan", dueDate: Number.MAX_SAFE_INTEGER + 1 }],
    ["clickup", "create_task", { listId: "abc", name: "Plan" }],
    ["clickup", "update_task", { taskId: "abc123" }],
    ["clickup", "update_task", { taskId: "abc123", status: undefined }],
    ["clickup", "update_task", { taskId: "../other", name: "Plan" }],
    ["clickup", "update_task", { taskId: "abc123", status: "x".repeat(129) }],
    ["hubspot", "create_contact", { properties: { email: "invalid" } }],
    ["hubspot", "create_contact", { properties: {} }],
    ["hubspot", "create_company", { properties: { name: " " } }],
    ["hubspot", "create_deal", { properties: { dealname: "Plan" } }],
    ["hubspot", "update_contact", { contactId: "123", properties: {} }],
    ["hubspot", "update_company", { companyId: "123", properties: { name: undefined } }],
    ["hubspot", "update_contact", { contactId: "123", properties: { custom: "unreviewed" } }],
    ["hubspot", "update_contact", { contactId: "../other", properties: { firstname: "Alex" } }],
    ["hubspot", "update_company", { companyId: "123", properties: { description: "x".repeat(10001) } }],
    ["hubspot", "update_deal", { dealId: "123", properties: { amount: "Infinity" } }],
    ["hubspot", "update_deal", { dealId: "123", properties: { amount: 42 } }],
  ])("rejects malformed or empty %s/%s writes: %j", (service, id, params) => {
    expect(validateActionParams(action(service as string, id as string), params as Record<string, unknown>).valid).toBe(false);
  });
  it.each([
    { fields: {} }, { fields: { Name: { url: "https://example.com" } } },
    { fields: { Name: [null] } }, { fields: { Name: [["nested"]] } },
    { fields: { Name: Array(101).fill("tag") } }, { fields: { Name: ["x".repeat(4097)] } },
    { fields: { Name: "x".repeat(10001) } }, { fields: { Name: Infinity } },
    { fields: { "": "blank field" } }, { fields: { "bad\u0000name": "bad field" } },
    { fields: { constructor: "unsafe field" } }, { fields: JSON.parse('{"__proto__":"unsafe"}') },
    { fields: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`field${i}`, "x"])) },
    { fields: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, "é".repeat(4000)])) },
    { baseId: "../other", fields: { Name: "Plan" } }, { tableId: "Table Name", fields: { Name: "Plan" } },
    { typecast: true, fields: { Name: "Plan" } },
  ])("rejects unsafe or unbounded Airtable cell updates: %j", (params) => {
    for (const id of ["create_record", "update_record"]) {
      expect(validateActionParams(action("airtable", id), { baseId, tableId, ...(id === "update_record" ? { recordId } : {}), ...params }).valid).toBe(false);
    }
  });
  it("accepts bounded Airtable scalar fields and explicit array/nullable clears without coercion", () => {
    const params = { baseId, tableId, recordId, fields: { Name: "", Tags: [], Count: null, "Field / name": false } };
    expect(action("airtable", "update_record").paramsSchema?.parse(params)).toEqual(params);
    expect(validateActionParams(action("airtable", "update_record"), { ...params, recordId: "../other" }).valid).toBe(false);
  });
  it("maps only explicitly reviewed task fields even when called without the schema boundary", () => {
    expect(action("asana", "update_task").directApi?.mapBody?.({ taskId: "123", completed: false, url: "bad", assignee: "other" })).toEqual({ data: { completed: false } });
    expect(action("clickup", "update_task").directApi?.mapBody?.({ taskId: "123", name: "Plan", url: "bad", notify_all: true })).toEqual({ name: "Plan" });
  });
});
