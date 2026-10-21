import { z } from "zod/v4";

/** Owner-agent orchestration only; these schemas never grant app-session authority. */
export const RefreshNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
export const RefreshBindingSchema = z.strictObject({
  appId: RefreshNameSchema,
  sourceId: RefreshNameSchema,
  service: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  action: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().trim().min(1).max(100),
  connectionId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  params: z.record(z.string().max(100), z.unknown()).default({}).refine(value => {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16384; }
    catch (error: unknown) {
      if (error instanceof TypeError) return false; // Cyclic/BigInt model input cannot be JSON.
      throw error;
    }
  }, "Data import parameters are too large or invalid"),
});
export type RefreshBinding = z.infer<typeof RefreshBindingSchema>;
export const DataImportRefreshInputSchema = RefreshBindingSchema.extend({ restart: z.boolean().optional() });
export const DataImportSourceInputSchema = z.strictObject({ appId: RefreshNameSchema, sourceId: RefreshNameSchema });
export const DataImportDeleteInputSchema = DataImportSourceInputSchema.extend({ userRequested: z.literal(true) });
export const DataImportUrlPreviewInputSchema = z.strictObject({ url: z.url({ protocol: /^https$/ }).max(2048) });
export const DataImportStatusSchema = z.strictObject({
  sourceId: RefreshNameSchema, appId: RefreshNameSchema,
  service: RefreshBindingSchema.shape.service, action: RefreshBindingSchema.shape.action,
  status: z.enum(["pending", "running", "complete", "backoff", "failed", "exhausted"]),
  pages: z.number().int().min(0).max(5), calls: z.number().int().min(0).max(8),
  bytes: z.number().int().min(0).max(2 * 1024 * 1024),
  retryAt: z.iso.datetime().nullable(), errorCode: z.enum(["source_unavailable", "budget_exhausted"]).nullable(),
});
export const DataImportPagesSchema = z.strictObject({ pages: z.array(z.unknown()).max(5) });
export const DataImportDeletedSchema = z.strictObject({ removed: z.literal(true) });
export const DataImportUrlPreviewSchema = z.strictObject({ url: z.url({ protocol: /^https$/ }).max(2048), title: z.string().max(200), description: z.string().max(500) });
