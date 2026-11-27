/** Checks for the fields of a saved journal, which is untrusted input. */

/** Thrown while a journal part is checked; `parseJournal` turns it into a result. */
export class FormatError extends Error {}

export function fail(): never {
  throw new FormatError("journal format");
}

export function obj(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

export function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value;
}

export function int(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail();
  return value;
}

export function text(value: unknown, max: number, min = 0): string {
  if (typeof value !== "string" || value.length < min || value.length > max) fail();
  return value;
}
