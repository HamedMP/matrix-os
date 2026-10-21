import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { CATALOG_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-catalog.js";

// Qualified synthetic server boundary: official Connect API Proxy docs require
// relative Zendesk paths and resolve the host from external_user_id/account_id.
// https://pipedream.com/docs/connect/api-proxy#apps-with-dynamic-domains
// The installed SDK itself runs here; no proxyGet/proxyPut methods are mocked.
// This proves SDK serialization/binding, not a live Zendesk account connection.
afterEach(() => vi.unstubAllGlobals());
describe("Zendesk dynamic domain through the installed Pipedream SDK", () => {
  it("serializes GET/PUT relative targets and lets only the selected owner's account determine the host", async () => {
    const domains: Record<string, string> = { "owner_1:apn_first": "first-support.zendesk.com", "owner_1:apn_second": "second-support.zendesk.com" };
    const forwarded: Array<{ url: URL; method: string; account: string; body?: unknown }> = [];
    const proxyTargets: string[] = [];
    const fetcher = vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const request = new URL(raw instanceof Request ? raw.url : String(raw));
      expect(request.origin).toBe("https://api.pipedream.com");
      if (request.pathname === "/v1/oauth/token") return Response.json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600 });
      expect(request.pathname).toMatch(/^\/v1\/connect\/proj_fixture\/proxy\//);
      const owner = request.searchParams.get("external_user_id")!;
      const account = request.searchParams.get("account_id")!;
      const domain = domains[`${owner}:${account}`];
      if (!domain) return Response.json({ error: "Account unavailable" }, { status: 403 });
      const target = Buffer.from(decodeURIComponent(request.pathname.split("/").at(-1)!), "base64url").toString("utf8");
      expect(target).toMatch(/^\/api\/v2\//); expect(target.startsWith("//")).toBe(false);
      proxyTargets.push(target);
      const url = new URL(target, `https://${domain}`);
      const method = init.method ?? "GET";
      forwarded.push({ url, method, account, ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return Response.json({ host: url.hostname, tickets: [], ticket: { id: 42, status: "open" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const client = await createPipedreamClient({ clientId: "synthetic-id", clientSecret: "synthetic-secret", projectId: "proj_fixture", environment: "production" });
    const definition = CATALOG_SERVICE_REGISTRY.zendesk;
    for (const account of ["apn_first", "apn_second"]) {
      const base = { pipedream: client, externalUserId: "owner_1", connection: { pipedream_account_id: account }, def: definition, serviceId: "zendesk" };
      const read = await executeIntegrationAction({ ...base, actionId: "list_tickets", actionDef: definition.actions.list_tickets, params: { limit: 25, cursor: "next" } });
      expect(read.data).toMatchObject({ host: domains[`owner_1:${account}`] });
      await executeIntegrationAction({ ...base, actionId: "update_ticket", actionDef: definition.actions.update_ticket, params: { ticketId: "42", status: "open" } });
      const callsBeforeInvalid = fetcher.mock.calls.length;
      for (const override of [{ subdomain: "attacker" }, { url: "https://attacker.test" }, { accountId: "apn_second" }]) {
        await expect(executeIntegrationAction({ ...base, actionId: "list_tickets", actionDef: definition.actions.list_tickets, params: override })).rejects.toThrow();
      }
      expect(fetcher.mock.calls.length).toBe(callsBeforeInvalid);
    }
    expect(forwarded.map(item => item.url.hostname)).toEqual(["first-support.zendesk.com", "first-support.zendesk.com", "second-support.zendesk.com", "second-support.zendesk.com"]);
    expect(forwarded.map(item => item.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    for (const read of forwarded.filter(item => item.method === "GET")) {
      expect(read.url.pathname).toBe("/api/v2/tickets.json"); expect(read.url.searchParams.get("page[size]")).toBe("25"); expect(read.url.searchParams.get("page[after]")).toBe("next");
    }
    for (const write of forwarded.filter(item => item.method === "PUT")) { expect(write.url.pathname).toBe("/api/v2/tickets/42.json"); expect(write.body).toEqual({ ticket: { status: "open" } }); }
    expect(proxyTargets.every(target => !target.includes("zendesk.com"))).toBe(true);
    await expect(executeIntegrationAction({ pipedream: client, externalUserId: "other_owner", connection: { pipedream_account_id: "apn_first" }, def: definition,
      serviceId: "zendesk", actionId: "list_tickets", actionDef: definition.actions.list_tickets, params: {} })).rejects.toThrow();
    expect(forwarded).toHaveLength(4);
  });
});
