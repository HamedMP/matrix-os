import { z } from "zod/v4";
import { NUMERIC_ID, UUID, optional, segment, strictFields, text, type CatalogField } from "./catalog-fields.js";
import type { ServiceAction } from "./types.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { FinanceWriteError, type createBoundedFinanceAction } from "./finance-write-request.js";

const name = (max: number): CatalogField => ({ ...text(max), schema: z.string().min(1).max(max).refine(value => value.trim().length > 0) });
const email: CatalogField = { schema: z.email().max(254), param: { type: "string", maxLength: 254 } };
const emptyText = (max: number): CatalogField => ({ schema: z.string().max(max), param: { type: "string", maxLength: max } });
function write(description: string, fields: Record<string, CatalogField>, api: NonNullable<ServiceAction["directApi"]>, omitted: string[] = []): ServiceAction {
  return { description, risk: "write", params: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.param])),
    paramsSchema: strictFields(fields).refine(params => Object.entries(params).some(([key, value]) => !omitted.includes(key) && value !== undefined)), directApi: api };
}
const pick = (params: Record<string, unknown>, mapping: Record<string, string>) => Object.fromEntries(Object.entries(mapping).filter(([key]) => params[key] !== undefined).map(([key, output]) => [output, params[key]]));
const metadata: CatalogField = {
  schema: z.record(z.string().min(1).max(40).regex(/^[^\[\]\x00-\x1f\x7f]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value)), z.string().max(500))
    .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 50),
  param: { type: "object", description: "1–50 string metadata entries; keys up to 40 characters without brackets, values up to 500 characters. Empty values remove individual keys." },
};
const stripeFields = { name: optional(name(256)), email: optional(email), phone: optional(emptyText(20)), description: optional(emptyText(500)), metadata: optional(metadata) };
const stripeUrl = "https://api.stripe.com/v1/customers";
const stripeBody = (params: Record<string, unknown>) => pick(params, { name: "name", email: "email", phone: "phone", description: "description", metadata: "metadata" });
const stripe: Record<string, ServiceAction> = {
  create_customer: write("Create one Stripe customer profile after approval; requires a customer-write key; never changes payment settings", { ...stripeFields, name: name(256) }, { method: "POST", url: stripeUrl, mapBody: stripeBody }),
  update_customer: write("Update supplied Stripe customer profile/metadata after approval; requires customer-write key", { customerId: text(128, /^cus_[A-Za-z0-9]+$/), ...stripeFields },
    { method: "POST", url: params => `${stripeUrl}/${segment(params, "customerId", text(128, /^cus_[A-Za-z0-9]+$/))}`, mapBody: stripeBody }, ["customerId"]),
};

const qbFields = { displayName: optional(name(500)), givenName: optional(emptyText(100)), familyName: optional(emptyText(100)), companyName: optional(emptyText(100)), email: optional(email), phone: optional(emptyText(30)), notes: optional(emptyText(2000)) };
const qbUrl = (params: Record<string, unknown>) => `https://quickbooks.api.intuit.com/v3/company/${segment(params, "companyId", NUMERIC_ID)}/customer?minorversion=75`;
const qbBody = (params: Record<string, unknown>) => ({ ...pick(params, { displayName: "DisplayName", givenName: "GivenName", familyName: "FamilyName", companyName: "CompanyName", notes: "Notes" }),
  ...(params.email !== undefined ? { PrimaryEmailAddr: { Address: params.email } } : {}), ...(params.phone !== undefined ? { PrimaryPhone: { FreeFormNumber: params.phone } } : {}) });
const quickbooks: Record<string, ServiceAction> = {
  create_customer: write("Create one customer profile in the verified QuickBooks company after approval", { companyId: NUMERIC_ID, ...qbFields, displayName: name(500) }, { method: "POST", url: qbUrl, mapBody: qbBody }, ["companyId"]),
  update_customer: write("Sparse-update a QuickBooks customer profile after approval using its current SyncToken; stale tokens fail upstream", { companyId: NUMERIC_ID, customerId: NUMERIC_ID, syncToken: NUMERIC_ID, ...qbFields },
    { method: "POST", url: qbUrl, mapBody: params => ({ Id: params.customerId, SyncToken: params.syncToken, sparse: true, ...qbBody(params) }) }, ["companyId", "customerId", "syncToken"]),
};
const xeroFields = { name: optional(name(255)), email: optional(email), firstName: optional(emptyText(255)), lastName: optional(emptyText(255)) };
const xeroUrl = "https://api.xero.com/api.xro/2.0/Contacts";
const xeroBody = (params: Record<string, unknown>) => ({ Contacts: [pick(params, { contactId: "ContactID", name: "Name", email: "EmailAddress", firstName: "FirstName", lastName: "LastName" })] });
const xero: Record<string, ServiceAction> = {
  create_contact: write("Create one contact profile in the verified Xero organization after approval; requires accounting.contacts", { tenantId: UUID, ...xeroFields, name: name(255) }, { method: "PUT", url: xeroUrl, mapBody: xeroBody }, ["tenantId"]),
  update_contact: write("Update supplied Xero contact profile fields after approval using its ContactID; requires accounting.contacts", { tenantId: UUID, contactId: UUID, ...xeroFields },
    { method: "POST", url: params => `${xeroUrl}/${segment(params, "contactId", UUID)}`, mapBody: xeroBody }, ["tenantId", "contactId"]),
};
export const FINANCE_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = { stripe, quickbooks, xero_accounting_api: xero };

/** Runs before generic accounting read dispatch; never falls back to an uncapped JSON proxy. */
export async function executeFinanceWriteAction(opts: {
  pipedream: PipedreamConnectClient & { boundedFinanceAction?: ReturnType<typeof createBoundedFinanceAction> };
  externalUserId: string; accountId: string; serviceId: string; actionId: string; params?: Record<string, unknown>;
}): Promise<{ data: unknown } | undefined> {
  if (!Object.hasOwn(FINANCE_WRITE_ACTIONS, opts.serviceId) || !Object.hasOwn(FINANCE_WRITE_ACTIONS[opts.serviceId], opts.actionId)) return undefined;
  if (!opts.pipedream.boundedFinanceAction) throw new FinanceWriteError();
  return { data: await opts.pipedream.boundedFinanceAction({ externalUserId: opts.externalUserId, accountId: opts.accountId, serviceId: opts.serviceId, actionId: opts.actionId, params: opts.params ?? {} }) };
}
