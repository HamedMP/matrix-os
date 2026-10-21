import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { CATALOG_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-catalog.js";

afterEach(() => vi.unstubAllGlobals());
describe("catalog headers through the real Pipedream SDK", () => {
  it.each(["xero_accounting_api", "quickbooks", "intercom"])("forwards %s provider headers exactly once", async serviceId => {
    const tenantId = "12345678-1234-1234-1234-123456789abc";
    const reads: { target: URL; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(raw instanceof Request ? raw.url : String(raw));
      if (url.pathname === "/v1/oauth/token") return Response.json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600 });
      if (!url.pathname.includes("/proxy/")) throw new Error("Unexpected synthetic endpoint");
      const target = new URL(Buffer.from(decodeURIComponent(url.pathname.split("/").at(-1)!), "base64url").toString("utf8"));
      reads.push({ target, headers: new Headers(init.headers) });
      if (target.pathname === "/connections") return Response.json([{ tenantId }]);
      if (target.pathname.includes("/companyinfo/")) return Response.json({ CompanyInfo: { Id: "1" } });
      return Response.json({ records: [] });
    }));
    const client = await createPipedreamClient({ clientId: "synthetic-id", clientSecret: "synthetic-secret", projectId: "proj_fixture", environment: "production" });
    const definition = CATALOG_SERVICE_REGISTRY[serviceId]!;
    const actionId = serviceId === "intercom" ? "list_conversations" : "list_invoices";
    await executeIntegrationAction({ pipedream: client, externalUserId: "owner_1", connection: { pipedream_account_id: "apn_1" },
      def: definition, actionDef: definition.actions[actionId]!, serviceId, actionId,
      params: serviceId === "xero_accounting_api" ? { tenantId } : serviceId === "quickbooks" ? { companyId: "123" } : {} });
    const action = reads.at(-1)!;
    if (serviceId === "xero_accounting_api") expect(action.headers.get("x-pd-proxy-xero-tenant-id")).toBe(tenantId);
    if (serviceId === "intercom") expect(action.headers.get("x-pd-proxy-intercom-version")).toBe("2.14");
    else expect(action.headers.get("x-pd-proxy-accept")).toBe("application/json");
    for (const read of reads) expect([...read.headers.keys()].some(key => key.startsWith("x-pd-proxy-x-pd-proxy-"))).toBe(false);
  });
});
