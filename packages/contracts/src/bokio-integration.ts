import { z } from "zod/v4";

export const BokioUuid = z.string().regex(/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/);
const page = z.strictObject({ page: z.number().int().min(1).max(100000).optional(), pageSize: z.number().int().min(1).max(100).optional() });
const empty = z.strictObject({});
export const BOKIO_ACTION_SPECS = {
  get_company: { path: "company-information", schema: empty, id: undefined },
  list_customers: { path: "customers", schema: page, id: undefined },
  get_customer: { path: "customers", schema: z.strictObject({ customerId: BokioUuid }), id: "customerId" },
  list_invoices: { path: "invoices", schema: page, id: undefined },
  get_invoice: { path: "invoices", schema: z.strictObject({ invoiceId: BokioUuid }), id: "invoiceId" },
  list_journal_entries: { path: "journal-entries", schema: page, id: undefined },
  get_journal_entry: { path: "journal-entries", schema: z.strictObject({ journalEntryId: BokioUuid }), id: "journalEntryId" },
  list_uploads: { path: "uploads", schema: page, id: undefined },
} as const;
const BOKIO_READ_ACTIONS = Object.fromEntries(Object.entries(BOKIO_ACTION_SPECS).map(([id, spec]) => [id, {
  description: id.replaceAll("_", " "), risk: "read" as const, paramsSchema: spec.schema,
  params: spec.schema === page ? { page: { type: "number" as const }, pageSize: { type: "number" as const } }
    : spec.id ? { [spec.id]: { type: "string" as const, required: true } } : {},
}]));

export const BOKIO_WRITE_SCOPES = ["customers:write", "invoices:write"] as const;
const name = z.string().min(1).max(500).refine(value => value.trim().length > 0);
const MAX_DRAFT_AMOUNT = 1000000000;
const line = z.strictObject({ description: name, productType: z.enum(["goods", "services"]), unitType: z.enum(["unspecified", "piece", "hour", "day", "month"]).optional(),
  quantity: z.number().finite().positive().max(1000000), unitPrice: z.number().finite().min(0).max(10000000), taxRate: z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)]) })
  .refine(value => value.quantity * value.unitPrice <= MAX_DRAFT_AMOUNT);
const customer = z.strictObject({ name, type: z.enum(["company", "private"]), customerNumber: z.string().min(1).max(24).refine(value => value.trim().length > 0).optional(),
  vatNumber: z.string().max(50).optional(), orgNumber: z.string().max(50).optional(), language: z.enum(["sv", "en"]).optional(),
  contactsDetails: z.array(z.strictObject({ name: z.string().max(200).optional(), email: z.email().max(254).optional(), phone: z.string().max(50).optional(), isDefault: z.boolean().optional() })
    .refine(value => Object.values(value).some(field => field !== undefined))).min(1).max(10).optional() });
const draft = z.strictObject({ customerId: BokioUuid, invoiceDate: z.iso.date(), dueDate: z.iso.date().optional(), lineItems: z.array(line).min(1).max(50) })
  .refine(value => value.dueDate === undefined || value.dueDate >= value.invoiceDate)
  .refine(value => value.lineItems.reduce((total, item) => total + item.quantity * item.unitPrice, 0) <= MAX_DRAFT_AMOUNT);
export const BOKIO_WRITE_ACTION_SPECS = {
  create_customer: { path: "customers", schema: customer, scope: "customers:write", id: undefined },
  create_draft_invoice: { path: "invoices", schema: draft, scope: "invoices:write", id: undefined },
  append_draft_line_item: { path: "invoices", schema: z.strictObject({ invoiceId: BokioUuid, lineItem: line }), scope: "invoices:write", id: "invoiceId" },
} as const;
const requiredString = { type: "string" as const, required: true };
const customerAction = {
  description: "Create one customer profile after approval; requires proven customers:write grant", risk: "write" as const, paramsSchema: customer,
  params: { name: requiredString, type: { ...requiredString, description: "company or private" }, customerNumber: { type: "string" as const }, vatNumber: { type: "string" as const }, orgNumber: { type: "string" as const }, language: { type: "string" as const }, contactsDetails: { type: "array" as const, description: "Up to 10 contacts with name, email, phone, isDefault" } },
};
interface BokioAction {
  description: string; risk: "read" | "write"; paramsSchema: z.ZodType;
  params: Record<string, { type: "string" | "number" | "array" | "object"; required?: boolean; description?: string }>;
}
export const BOKIO_ACTIONS: Record<string, BokioAction> = { ...BOKIO_READ_ACTIONS,
  create_customer: customerAction,
  create_draft_invoice: { description: "Create a SEK invoice draft after approval; never publishes, sends or records accounting", risk: "write" as const, paramsSchema: draft,
    params: { customerId: requiredString, invoiceDate: requiredString, dueDate: { type: "string" as const }, lineItems: { type: "array" as const, required: true, description: "1–50 lines: description, productType goods/services, optional unitType, quantity, unitPrice, taxRate 0/6/12/25" } } },
  append_draft_line_item: { description: "Append one line to an existing invoice draft after approval; upstream rejects published invoices", risk: "write" as const, paramsSchema: BOKIO_WRITE_ACTION_SPECS.append_draft_line_item.schema,
    params: { invoiceId: requiredString, lineItem: { type: "object" as const, required: true, description: "description, productType goods/services, optional unitType, quantity, unitPrice, taxRate 0/6/12/25" } } },
};
export const BOKIO_ACTION_SCOPES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(BOKIO_ACTION_SPECS).map(([id, spec]) => [id, `${spec.path}:read`])),
  ...Object.fromEntries(Object.entries(BOKIO_WRITE_ACTION_SPECS).map(([id, spec]) => [id, spec.scope])),
};
