import type { Context } from "hono";
import { z } from "zod/v4";

// Bound JSON nesting and keep special object keys out of downstream parsers.
function isSafeJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isSafeJson(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(([key, item]) => key.length <= 128
    && key !== "__proto__" && key !== "prototype" && key !== "constructor" && isSafeJson(item, depth + 1));
}

export const HostedToolArguments = z.custom<Record<string, unknown>>(value =>
  value !== null && typeof value === "object" && !Array.isArray(value) && isSafeJson(value));

export async function readHostedToolJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return null;
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}
