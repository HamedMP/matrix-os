import type { z } from "zod/v4";
import { ZellijOutputError, type ZellijStructuredCommand } from "./errors.js";

// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
export type ZellijInventorySchema<T> = z.ZodType<T> & { readonly element: z.ZodObject };

/**
 * Extract and validate the JSON payload of a structured Zellij command. Any
 * output that is not the expected JSON (plain text, ANSI-coloured errors from
 * a stale server generation, schema drift) becomes a typed ZellijOutputError,
 * never a raw SyntaxError or ZodError.
 */
export function parseZellijStructuredOutput<T>(
  raw: string,
  schema: ZellijInventorySchema<T>,
  command: ZellijStructuredCommand,
): T {
  // ANSI escapes contain "[" and would otherwise be mistaken for a JSON array.
  const output = raw.replace(ANSI_SEQUENCE, "").trim();
  const arrayStart = output.indexOf("[");
  const objectStart = output.indexOf("{");
  const start = arrayStart < 0
    ? objectStart
    : objectStart < 0
      ? arrayStart
      : Math.min(arrayStart, objectStart);
  const end = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
  if (start < 0 || end < start) throw new ZellijOutputError(command, "non_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ZellijOutputError(command, "non_json");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const invalidFields = new Set<string>(); // Bounded by the number of declared fields in the schema.
    for (const issue of result.error.issues) {
      const field = issue.path[1];
      if (typeof field === "string" && Object.hasOwn(schema.element.shape, field)) invalidFields.add(field);
    }
    throw new ZellijOutputError(command, "schema_invalid", [...invalidFields]);
  }
  return result.data;
}
