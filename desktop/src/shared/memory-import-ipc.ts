import { z } from "zod/v4";
export const MemoryImportProviderSchema = z.enum(["notes", "mail", "calendar"]);
export const MemoryImportRecordSchema = z
  .object({
    externalId: z.string().trim().min(1).max(512),
    title: z.string().trim().min(1).max(256),
    content: z.string().trim().min(1).max(65536),
    kind: z.enum(["note", "email", "calendar", "document"]),
    collection: z.string().trim().min(1).max(200),
    occurredAt: z.iso.datetime().optional(),
    metadata: z
      .record(z.string().max(64), z.string().max(2000))
      .refine((x) => Object.keys(x).length <= 20)
      .optional(),
  })
  .strict();
export const MemoryImportInventorySchema = z
  .object({
    collections: z
      .array(
        z
          .object({
            id: z.string().min(1).max(1024),
            label: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(100),
    warnings: z.array(z.string().max(256)).max(20),
  })
  .strict();
export const MemoryImportBatchSchema = z
  .object({
    records: z.array(MemoryImportRecordSchema).max(100),
    warnings: z.array(z.string().max(256)).max(20),
  })
  .strict()
  .refine((x) => x.records.reduce((n, r) => n + r.content.length, 0) <= 1000000)
  .refine(
    (x) =>
      new Set(x.records.map((r) => r.externalId)).size === x.records.length,
  );
const ErrorResult = z
  .object({
    status: z.literal("error"),
    code: z.enum([
      "unsupported",
      "permission_denied",
      "unavailable",
      "selection_required",
      "expired",
      "invalid_export",
      "timeout",
    ]),
    message: z.string().max(256),
  })
  .strict();
const Cancelled = z.object({ status: z.literal("cancelled") }).strict();
export const MemoryImportPreviewRequestSchema = z
  .object({
    provider: MemoryImportProviderSchema,
    collectionIds: z.array(z.string().min(1).max(1024)).min(1).max(10),
    limit: z.number().int().min(1).max(100),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict()
  .refine((x) => !x.from || !x.to || Date.parse(x.from) <= Date.parse(x.to));
const Preview = MemoryImportBatchSchema.safeExtend({
  status: z.literal("preview"),
  selectionId: z.uuid(),
});
export const MEMORY_IMPORT_INVOKE = {
  "memory:import-inventory": {
    request: z.object({ provider: MemoryImportProviderSchema }).strict(),
    response: z.union([
      MemoryImportInventorySchema.extend({ status: z.literal("ready") }),
      ErrorResult,
    ]),
  },
  "memory:import-preview": {
    request: MemoryImportPreviewRequestSchema,
    response: z.union([Preview, ErrorResult]),
  },
  "memory:import-file": {
    request: z.object({}).strict(),
    response: z.union([Preview, Cancelled, ErrorResult]),
  },
  "memory:import-confirm": {
    request: z
      .object({
        selectionId: z.uuid(),
        externalIds: z
          .array(z.string().min(1).max(512))
          .min(1)
          .max(100)
          .optional(),
      })
      .strict(),
    response: z.union([
      MemoryImportBatchSchema.safeExtend({ status: z.literal("confirmed") }),
      ErrorResult,
    ]),
  },
  "memory:import-cancel": {
    request: z.object({}).strict(),
    response: z.object({ ok: z.boolean() }).strict(),
  },
} as const;
export type MemoryImportProvider = z.infer<typeof MemoryImportProviderSchema>;
export type MemoryImportRecord = z.infer<typeof MemoryImportRecordSchema>;
export type MemoryImportBatch = z.infer<typeof MemoryImportBatchSchema>;
export type MemoryImportPreviewRequest = z.infer<
  typeof MemoryImportPreviewRequestSchema
>;
