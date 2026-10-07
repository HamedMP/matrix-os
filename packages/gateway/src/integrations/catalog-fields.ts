import { z } from "zod/v4";
import type { ActionParam } from "./types.js";

export interface CatalogField { schema: z.ZodType; param: ActionParam }
export const optional = (field: CatalogField): CatalogField => ({ schema: field.schema.optional(), param: { ...field.param, required: false } });
export const text = (maxLength: number, pattern?: RegExp): CatalogField => ({
  schema: pattern ? z.string().min(1).max(maxLength).regex(pattern) : z.string().min(1).max(maxLength),
  param: { type: "string", required: true, minLength: 1, maxLength, ...(pattern ? { pattern: pattern.source } : {}) },
});
export const integer = (minimum: number, maximum: number): CatalogField => ({
  schema: z.number().int().min(minimum).max(maximum), param: { type: "number", required: true, minimum, maximum },
});
export const choice = (values: readonly [string, ...string[]]): CatalogField => ({ schema: z.enum(values), param: { type: "string", required: true } });
export const ID = text(128, /^[A-Za-z0-9_-]+$/);
export const NUMERIC_ID = text(32, /^\d+$/);
export const GRAPH_ID = text(512, /^[A-Za-z0-9_+=-]+$/);
export const UUID = text(36, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
export const CURSOR = optional(text(2048, /^[^\s\x00-\x1f\x7f]+$/));
export const LIMIT = optional(integer(1, 100));
export const pageFields = { limit: LIMIT, cursor: CURSOR };
export const strictFields = (fields: Record<string, CatalogField>) => z.strictObject(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.schema])));
export const segment = (params: Record<string, unknown>, name: string, field = ID) => encodeURIComponent(field.schema.parse(params[name]) as string);

/** Explicit rectangles only: named ranges or whole columns can conceal unbounded reads. */
export function sheetRectangle(range: string): { rows: number; columns: number } | null {
  const match = /^(?:(?:[A-Za-z0-9_ .-]+|'(?:[^'\x00-\x1f]|'')+')!)?([A-Z]{1,3})([1-9]\d{0,5})(?::([A-Z]{1,3})([1-9]\d{0,5}))?$/.exec(range);
  if (!match) return null;
  const column = (name: string) => [...name].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
  const columns = column(match[3] ?? match[1]) - column(match[1]) + 1;
  const rows = Number(match[4] ?? match[2]) - Number(match[2]) + 1;
  return columns > 0 && rows > 0 && columns * rows <= 5000 ? { rows, columns } : null;
}
export const SHEET_RANGE: CatalogField = {
  schema: z.string().min(1).max(256).refine(value => sheetRectangle(value) !== null),
  param: { type: "string", required: true, minLength: 1, maxLength: 256, description: "Explicit A1 rectangle, at most 5,000 cells (for example 'Budget'!A1:D100)" },
};
export const SHEET_VALUES: CatalogField = {
  schema: z.array(z.array(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).min(1).max(100)).min(1).max(1000)
    .refine(rows => rows.reduce((total, row) => total + row.length, 0) <= 1000)
    .refine(rows => Buffer.byteLength(JSON.stringify(rows), "utf8") <= 64 * 1024),
  param: { type: "array", required: true, description: "Up to 1,000 cells and 64 KiB of literal values; formulas are not evaluated" },
};
