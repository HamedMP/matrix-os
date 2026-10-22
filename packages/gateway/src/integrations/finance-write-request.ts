import { z } from "zod/v4";
import { FINANCE_WRITE_ACTIONS } from "./finance-writes.js";
import { createBoundedIntegrationProxy, withinIntegrationDeadline, type BoundedIntegrationProxyOptions } from "./bounded-proxy-transport.js";
import { NUMERIC_ID, UUID } from "./catalog-fields.js";

export class FinanceWriteError extends Error {
  constructor() { super("The customer profile change could not be confirmed"); this.name = "FinanceWriteError"; }
}
const inputSchema = z.strictObject({ externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/), accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  serviceId: z.enum(["stripe", "quickbooks", "xero_accounting_api"]), actionId: z.string().min(1).max(40), params: z.record(z.string(), z.unknown()) });
const companySchema = z.object({ CompanyInfo: z.object({ Id: NUMERIC_ID.schema }) });
const tenantsSchema = z.array(z.object({ tenantId: UUID.schema })).max(100);

/** Fixed profile actions only. No payment instruments, balances, invoices, ledgers, or arbitrary URLs.
 * Stripe requires form encoding: docs.stripe.com/api/customers/{create,update}.
 * Intuit requires Id + SyncToken on sparse updates; Xero tenant membership is rechecked every call.
 */
export function createBoundedFinanceAction(options: Omit<BoundedIntegrationProxyOptions, "allowedOrigins">) {
  const proxy = createBoundedIntegrationProxy({ ...options, allowedOrigins: ["https://api.stripe.com", "https://quickbooks.api.intuit.com", "https://api.xero.com"] });
  return async (raw: unknown, callerSignal?: AbortSignal): Promise<unknown> => {
    try {
      const input = inputSchema.parse(raw);
      const action = Object.hasOwn(FINANCE_WRITE_ACTIONS[input.serviceId], input.actionId) ? FINANCE_WRITE_ACTIONS[input.serviceId][input.actionId] : undefined;
      if (!action?.paramsSchema || !action.directApi || action.risk !== "write") throw new FinanceWriteError();
      const params = action.paramsSchema.parse(input.params) as Record<string, unknown>;
      const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const identity = { externalUserId: input.externalUserId, accountId: input.accountId };
      const api = action.directApi;
      const url = typeof api.url === "function" ? api.url(params) : api.url;
      let tenantId: string | undefined;
      if (input.serviceId === "quickbooks") {
        // CompanyInfo.Id is the resource ID, not the realm. Authorization is proven
        // by a successful exact-company request under the immutable selected account.
        companySchema.parse(await proxy({ ...identity, method: "GET", url: `https://quickbooks.api.intuit.com/v3/company/${params.companyId}/companyinfo/${params.companyId}?minorversion=75` }, signal));
      } else if (input.serviceId === "xero_accounting_api") {
        const tenants = tenantsSchema.parse(await proxy({ ...identity, method: "GET", url: "https://api.xero.com/connections" }, signal));
        tenantId = String(params.tenantId);
        if (!tenants.some(tenant => tenant.tenantId === tenantId)) throw new FinanceWriteError();
      }
      const mapped = api.mapBody!(params);
      let body: string; let contentType: "application/json" | "application/x-www-form-urlencoded";
      if (input.serviceId === "stripe") {
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(mapped)) {
          if (key === "metadata") for (const [metaKey, metaValue] of Object.entries(value as Record<string, string>)) form.set(`metadata[${metaKey}]`, metaValue);
          else form.set(key, String(value));
        }
        body = form.toString(); contentType = "application/x-www-form-urlencoded";
      } else { body = JSON.stringify(mapped); contentType = "application/json"; }
      return await withinIntegrationDeadline(() => proxy({ ...identity, url, method: api.method, body, contentType, ...(tenantId ? { tenantId } : {}) }, signal), signal);
    } catch (error: unknown) {
      console.warn("[integrations] Finance profile write failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      throw new FinanceWriteError();
    }
  };
}
