import { describe, expect, it, vi } from "vitest";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import { getService } from "../../packages/gateway/src/integrations/registry.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import { bindDiscoveredComponentKey } from "../../scripts/lib/pipedream-integration-verification.js";

const organization = "452c1a86-a0af-475b-b03f-724878b0f387";
const project = { id: 7, name: "Product", organization, api_token: "fixture-secret", config: { private: true } };

function fixture(data: unknown = { count: 1, next: null, results: [project] }) {
  const proxyGet = vi.fn().mockResolvedValue(data);
  const pipedream = { proxyGet, runAction: vi.fn() } as unknown as PipedreamConnectClient;
  const def = getService("posthog")!;
  const execute = (params?: Record<string, unknown>) => executeIntegrationAction({
    pipedream, externalUserId: "pd_owner", connection: { pipedream_account_id: "pd_selected" },
    def, actionDef: def.actions.list_projects, serviceId: "posthog", actionId: "list_projects", params,
  });
  return { proxyGet, pipedream, execute };
}

function readRoute(pipedream: PipedreamConnectClient, owner: string | null = "owner") {
  const touchServiceUsage = vi.fn().mockResolvedValue(undefined);
  const listConnectedServices = vi.fn().mockResolvedValue([
    { id: "connection_work", user_id: "owner", service: "posthog", account_label: "Work",
      pipedream_account_id: "pd_selected", status: "active" },
    { id: "connection_personal", user_id: "owner", service: "posthog", account_label: "Personal",
      pipedream_account_id: "pd_personal", status: "active" },
  ]);
  const db = { listConnectedServices,
    getUserById: vi.fn().mockResolvedValue({ pipedream_external_id: "pd_owner" }), touchServiceUsage,
  } as unknown as PlatformDb;
  const app = createIntegrationReadCallRoutes({ db, pipedream, resolveUserId: async () => owner });
  const call = (params: Record<string, unknown> = {}, label = "Work") => app.request("/read-call", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "posthog", action: "list_projects", label, params }),
  });
  return { call, touchServiceUsage, listConnectedServices };
}

describe("PostHog API-key project discovery", () => {
  it("executes the originally advertised no-params action with the selected owner/account", async () => {
    const { execute, proxyGet, pipedream } = fixture();
    expect(await execute({})).toEqual({ data: {
      results: [{ id: 7, name: "Product", organization }], count: 1, nextOffset: null,
    } });
    expect(proxyGet).toHaveBeenCalledExactlyOnceWith({
      externalUserId: "pd_owner", accountId: "pd_selected", url: "https://us.posthog.com/api/projects/",
      params: { limit: "25", offset: "0" },
    });
    expect(pipedream.runAction).not.toHaveBeenCalled();
  });

  it("makes the existing authenticated read-call usable instead of returning 501", async () => {
    const { pipedream, proxyGet } = fixture();
    const { call, touchServiceUsage, listConnectedServices } = readRoute(pipedream);
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "posthog", action: "list_projects", data: {
      results: [{ id: 7, name: "Product", organization }], count: 1, nextOffset: null,
    } });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: "pd_owner", accountId: "pd_selected" }));
    expect(touchServiceUsage).toHaveBeenCalledExactlyOnceWith("connection_work");
    expect(listConnectedServices).toHaveBeenCalledExactlyOnceWith("owner");
  });

  it("supports omission of params and a safe empty page", async () => {
    const { execute } = fixture({ count: 0, next: null, results: [] });
    expect(await execute()).toEqual({ data: { results: [], count: 0, nextOffset: null } });
  });

  it("reads one explicit EU organization page without following or leaking upstream pagination URLs", async () => {
    const { execute, proxyGet } = fixture({ count: 20, next: "http://127.0.0.1/private?api_key=fixture-secret", results: [project],
      previous: "https://example.invalid/private", api_token: "fixture-secret" });
    expect(await execute({ region: "eu", organizationId: organization, limit: 1, offset: 5 })).toEqual({
      data: { results: [{ id: 7, name: "Product", organization }], count: 20, nextOffset: 6 },
    });
    expect(proxyGet).toHaveBeenCalledExactlyOnceWith({ externalUserId: "pd_owner", accountId: "pd_selected",
      url: `https://eu.posthog.com/api/organizations/${organization}/projects/`, params: { limit: "1", offset: "5" } });
  });

  it("preserves the selected identity on a subsequent bounded page", async () => {
    const { execute, proxyGet } = fixture({ next: null, results: [project] });
    await execute({ region: "eu", offset: 26, limit: 100 });
    expect(proxyGet).toHaveBeenCalledExactlyOnceWith({ externalUserId: "pd_owner", accountId: "pd_selected",
      url: "https://eu.posthog.com/api/projects/", params: { limit: "100", offset: "26" } });
  });

  it("advances by the requested limit when a short page still has a continuation", async () => {
    const { execute, proxyGet } = fixture({ count: 50, next: "https://us.posthog.com/api/projects/?offset=30&limit=25", results: [project] });
    expect(await execute({ offset: 5, limit: 25 })).toEqual({ data: {
      results: [{ id: 7, name: "Product", organization }], count: 50, nextOffset: 30,
    } });
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });

  it("lets the existing live verifier bind this read without inventing a component key", async () => {
    const def = getService("posthog")!;
    const action = bindDiscoveredComponentKey({ serviceId: "posthog", actionId: "list_projects",
      action: def.actions.list_projects, discovered: [] });
    const params = { region: "eu", organizationId: organization, offset: 5, limit: 1 };
    expect(typeof action.directApi?.url === "function" && action.directApi.url(params))
      .toBe(`https://eu.posthog.com/api/organizations/${organization}/projects/`);
    expect(action.directApi?.mapParams?.(params)).toEqual({ offset: "5", limit: "1" });
    const { pipedream, proxyGet } = fixture();
    const result = await executeIntegrationAction({ pipedream, externalUserId: "pd_owner",
      connection: { pipedream_account_id: "pd_selected" }, def, actionDef: action,
      serviceId: "posthog", actionId: "list_projects", params });
    expect(result.data).toEqual({ results: [{ id: 7, name: "Product", organization }], count: 1, nextOffset: null });
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });

  it.each([organization, organization.toUpperCase()])("normalizes UUID casing for the selected organization and provider comparison: %s", async providerOrganization => {
    const { execute, proxyGet } = fixture({ results: [{ ...project, organization: providerOrganization }], next: null });
    expect(await execute({ organizationId: organization.toUpperCase() })).toEqual({ data: {
      results: [{ id: 7, name: "Product", organization }], nextOffset: null,
    } });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      url: `https://us.posthog.com/api/organizations/${organization}/projects/`,
    }));
  });

  it.each([
    { region: "self-hosted" }, { region: "https://eu.posthog.com" }, { host: "https://127.0.0.1" },
    { url: "https://example.invalid" }, { headers: { Authorization: "fixture-secret" } },
    { organizationId: "../private" }, { organizationId: "" }, { organizationId: null },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: Infinity }, { limit: "25" },
    { offset: -1 }, { offset: 1.5 }, { offset: 1_000_001 }, { offset: NaN }, { offset: "1" },
  ])("rejects invalid selectors and target overrides before dispatch: %j", async params => {
    const { execute, proxyGet } = fixture();
    expect(validateActionParams(getService("posthog")!.actions.list_projects, params).valid).toBe(false);
    await expect(execute(params)).rejects.toThrow("Invalid action parameters");
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it.each([
    { results: [project] }, { results: {}, next: null }, { results: [project], next: 3 },
    { results: [project], next: "" }, { results: [project], next: null, count: -1 },
    { results: [{ ...project, id: "7" }], next: null }, { results: [{ ...project, id: 1.5 }], next: null },
    { results: [{ ...project, name: "x".repeat(201) }], next: null },
    { results: [{ ...project, organization: "private" }], next: null },
    { results: [project, project], next: null }, { results: [], next: "https://us.posthog.com/api/projects/?offset=1" },
  ])("rejects malformed or oversized pages without returning raw project configuration: %j", async data => {
    const { execute, proxyGet } = fixture(data);
    await expect(execute({ limit: 1 })).rejects.toThrow("Integration response unavailable");
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });

  it("rejects a page outside the selected organization and pagination bound", async () => {
    await expect(fixture().execute({ organizationId: "095be615-a8ad-4c33-8e9c-c7612fbf6c9f" }))
      .rejects.toThrow("Integration response unavailable");
    await expect(fixture({ next: "https://us.posthog.com/api/projects/", results: [project] }).execute({ offset: 1_000_000 }))
      .rejects.toThrow("Integration response unavailable");
  });

  it("keeps route authorization and invalid-parameter failures ahead of provider dispatch", async () => {
    const { pipedream, proxyGet } = fixture();
    expect((await readRoute(pipedream, null).call()).status).toBe(401);
    const { call, touchServiceUsage } = readRoute(pipedream);
    expect((await call({ region: "private" })).status).toBe(400);
    expect((await call({}, "Missing")).status).toBe(400);
    expect(proxyGet).not.toHaveBeenCalled();
    expect(touchServiceUsage).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error("upstream fixture-secret"), { statusCode: 403 }), 502],
    [Object.assign(new Error("upstream fixture-secret"), { statusCode: 429 }), 429],
    [Object.assign(new Error("upstream fixture-secret"), { name: "TimeoutError" }), 504],
  ])("preserves safe failure mapping and never retries a different region: %j", async (error, status) => {
    const { pipedream, proxyGet } = fixture();
    proxyGet.mockRejectedValue(error);
    const { call, touchServiceUsage } = readRoute(pipedream);
    const response = await call({ region: "eu" });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("fixture-secret");
    expect(proxyGet).toHaveBeenCalledTimes(1);
    expect(proxyGet.mock.calls[0][0].url).toBe("https://eu.posthog.com/api/projects/");
    expect(touchServiceUsage).not.toHaveBeenCalled();
  });
});
