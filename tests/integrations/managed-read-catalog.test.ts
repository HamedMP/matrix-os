import { describe, expect, it, vi } from "vitest";
import { projectIntegrationCatalog } from "../../packages/gateway/src/integrations/catalog-projection.js";
import { getService } from "../../packages/gateway/src/integrations/registry.js";
const services = [getService("posthog_oauth")!, getService("bokio")!];
const options = { services, uid: "owner", capabilityIdentityFailed: false, authoritative: true, readOnly: true, logoUrl: (s: typeof services[number]) => s.logoUrl };
describe("managed scoped read catalog", () => {
  it("projects only currently discovered read actions and supported parameters", async () => {
    const presetBroker = {
      listAvailableActions: vi.fn(async (_owner, service) => service === "bokio" ? ["get_company"] : ["get_project"]),
      listAvailableActionParams: vi.fn(async () => ({ get_project: [] })),
    };
    const result = await projectIntegrationCatalog({ ...options, presetBroker });
    expect(result.map(s => s.id)).toEqual(["posthog_oauth", "bokio"]);
    expect(Object.keys(result[0]!.actions)).toEqual(["get_project"]);
    expect(result[0]!.actions.get_project!.params).toEqual({});
    expect(Object.keys(result[1]!.actions)).toEqual(["get_company"]);
  });
  it("retains Granola required fields when its broker only narrows list_notes", async () => {
    const result = await projectIntegrationCatalog({ ...options, services: [getService("granola")!], presetBroker: {
      listAvailableActions: async () => ["get_note", "search_notes", "list_notes"],
      listAvailableActionParams: async () => ({ list_notes: ["limit"] }),
    } });
    expect(result[0]!.actions.get_note!.params.noteId?.required).toBe(true);
    expect(result[0]!.actions.search_notes!.params.query?.required).toBe(true);
    expect(Object.keys(result[0]!.actions.list_notes!.params)).toEqual(["limit"]);
  });
  it("does not advertise managed actions when capability identity fails or broker is absent", async () => {
    expect(await projectIntegrationCatalog(options)).toEqual([]);
    const result = await projectIntegrationCatalog({ ...options, capabilityIdentityFailed: true, presetBroker: {} });
    expect(result.every(s => Object.keys(s.actions).length === 0)).toBe(true);
  });
});
