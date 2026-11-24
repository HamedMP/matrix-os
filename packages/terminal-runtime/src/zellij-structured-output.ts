import type { z } from "zod/v4";
import { stripAnsi, ZellijOutputError } from "./errors.js";

/**
 * Extract and validate the JSON payload of a structured Zellij command. Any
 * output that is not the expected JSON (plain text, ANSI-coloured errors from
 * a stale server generation, schema drift) becomes a typed ZellijOutputError,
 * never a raw SyntaxError or ZodError.
 */
export function parseZellijStructuredOutput<T>(raw: string, schema: z.ZodType<T>): T {
  // ANSI escapes contain "[" and would otherwise be mistaken for a JSON array.
  const output = stripAnsi(raw).trim();
  const arrayStart = output.indexOf("[");
  const objectStart = output.indexOf("{");
  const start = arrayStart < 0
    ? objectStart
    : objectStart < 0
      ? arrayStart
      : Math.min(arrayStart, objectStart);
  const end = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
  if (start < 0 || end < start) throw ZellijOutputError.fromOutput("non_json", raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw ZellijOutputError.fromOutput("non_json", raw, { cause: error });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw ZellijOutputError.fromOutput("schema_invalid", raw);
  return result.data;
}
