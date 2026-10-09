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
export const BOKIO_ACTIONS = Object.fromEntries(Object.entries(BOKIO_ACTION_SPECS).map(([id, spec]) => [id, {
  description: id.replaceAll("_", " "), risk: "read" as const, paramsSchema: spec.schema,
  params: spec.schema === page ? { page: { type: "number" as const }, pageSize: { type: "number" as const } }
    : spec.id ? { [spec.id]: { type: "string" as const, required: true } } : {},
}]));
