import { z } from "zod/v4";
import type { PipedreamConnectClient } from "./pipedream.js";
import { CATALOG_SERVICE_REGISTRY } from "./registry-catalog.js";
import { UUID } from "./catalog-fields.js";

export class CatalogAccountBindingError extends Error {
  constructor() { super("The selected organization is not available to this connection"); this.name = "CatalogAccountBindingError"; }
}
const connectionsSchema = z.array(z.object({ tenantId: UUID.schema })).max(100);
const companySchema = z.object({ CompanyInfo: z.object({ Id: z.string().regex(/^\d+$/).max(32) }) });

/** Resolve organization selection with the exact connection before any accounting read. */
export async function executeCatalogBoundAction(opts: {
  pipedream: PipedreamConnectClient; externalUserId: string; accountId: string;
  serviceId: string; actionId: string; params?: Record<string, unknown>;
}): Promise<{ data: unknown } | undefined> {
  if (opts.serviceId !== "quickbooks" && opts.serviceId !== "xero_accounting_api") return undefined;
  const action = CATALOG_SERVICE_REGISTRY[opts.serviceId].actions[opts.actionId];
  if (!action?.paramsSchema || !action.directApi || action.risk !== "read") throw new CatalogAccountBindingError();
  const validation = action.paramsSchema.safeParse(opts.params ?? {});
  if (!validation.success) throw new CatalogAccountBindingError();
  const params = validation.data as Record<string, unknown>;
  const identity = { externalUserId: opts.externalUserId, accountId: opts.accountId };
  const api = action.directApi;
  const url = typeof api.url === "function" ? api.url(params) : api.url;
  const query = api.mapParams?.(params);

  if (opts.serviceId === "xero_accounting_api") {
    const data = await opts.pipedream.proxyGet({ ...identity, url: "https://api.xero.com/connections" });
    const connections = connectionsSchema.safeParse(data);
    if (!connections.success) throw new CatalogAccountBindingError();
    if (opts.actionId === "list_organizations") return { data };
    if (!connections.data.some(connection => connection.tenantId === params.tenantId)) throw new CatalogAccountBindingError();
    return { data: await opts.pipedream.proxyGet({ ...identity, url, ...(query ? { params: query } : {}),
      headers: { "xero-tenant-id": String(params.tenantId), Accept: "application/json" } }) };
  }

  // QuickBooks access tokens are company-bound. A successful same-account preflight
  // proves the chosen realm; CompanyInfo.Id is its resource ID, not the realm ID.
  // Callers cannot inject queries or bypass Intuit's company authorization.
  const companyId = String(params.companyId);
  const company = await opts.pipedream.proxyGet({ ...identity,
    url: `https://quickbooks.api.intuit.com/v3/company/${companyId}/companyinfo/${companyId}`,
    params: { minorversion: "75" }, headers: { Accept: "application/json" } });
  const verified = companySchema.safeParse(company);
  if (!verified.success) throw new CatalogAccountBindingError();
  if (opts.actionId === "get_company") return { data: company };
  return { data: await opts.pipedream.proxyGet({ ...identity, url, ...(query ? { params: query } : {}), headers: { Accept: "application/json" } }) };
}
