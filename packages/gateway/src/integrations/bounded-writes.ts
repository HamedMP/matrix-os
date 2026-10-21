import { z } from "zod/v4";
import { strictFields, type CatalogField } from "./catalog-fields.js";
import type { DirectApi, ServiceAction } from "./types.js";

/** All catalog extensions here retain the gateway's explicit write approval. */
export function boundedWrite(description: string, fields: Record<string, CatalogField>, api: DirectApi, schema?: z.ZodType): ServiceAction {
  return {
    description, risk: "write",
    params: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.param])),
    paramsSchema: schema ?? strictFields(fields), directApi: api,
  };
}
export const nonblank = (max: number): CatalogField => ({
  schema: z.string().min(1).max(max).refine(value => value.trim().length > 0),
  param: { type: "string", required: true, minLength: 1, maxLength: max },
});
export const email: CatalogField = {
  schema: z.email().max(254), param: { type: "string", required: true, minLength: 3, maxLength: 254 },
};
export const phone: CatalogField = {
  schema: z.string().min(1).max(64).regex(/^[+0-9(). #x-]+$/).refine(value => /\d/.test(value)),
  param: { type: "string", required: true, minLength: 1, maxLength: 64 },
};
export const utcDateTime: CatalogField = {
  schema: z.iso.datetime().max(30),
  param: { type: "string", required: true, maxLength: 30, description: "UTC ISO 8601 timestamp ending in Z" },
};
export const folderName: CatalogField = {
  schema: z.string().min(1).max(255).regex(/^[^\\/:*?"<>|\x00-\x1f\x7f]+$/)
    .refine(value => value.trim() === value && value !== "." && value !== ".." && !value.endsWith(".")),
  param: { type: "string", required: true, minLength: 1, maxLength: 255, description: "One folder name; no path separators or control characters" },
};
