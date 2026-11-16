/**
 * Converts a scoped app bridge result into the JSON wire value the owner's
 * direct app bridge already returns over HTTP. node-postgres yields `Date`
 * objects for `date` and `timestamptz` columns; each becomes its ISO-8601
 * instant, which is what `c.json()` produces for the owner. Every other value
 * outside plain JSON fails closed instead of being stringified.
 */
import { z } from "zod/v4";

export type BridgeJsonValue = string | number | boolean | null | BridgeJsonValue[] | { [key: string]: BridgeJsonValue };

export type UnsupportedBridgeValue =
  | "non_finite_number"
  | "invalid_date"
  | "unsupported_type"
  | "unsupported_object"
  | "too_deep"
  | "too_large";

export class BridgeJsonError extends Error {
  constructor(readonly reason: UnsupportedBridgeValue) {
    super(`Unsupported app bridge result value: ${reason}`);
    this.name = "BridgeJsonError";
  }
}

const MAX_DEPTH = 64;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function convert(value: unknown, depth: number): BridgeJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BridgeJsonError("non_finite_number");
    return value;
  }
  if (typeof value !== "object") throw new BridgeJsonError("unsupported_type");
  if (depth >= MAX_DEPTH) throw new BridgeJsonError("too_deep");
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new BridgeJsonError("invalid_date");
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => convert(item, depth + 1));
  if (!isPlainObject(value)) throw new BridgeJsonError("unsupported_object");
  // fromEntries defines own properties, so a JSONB "__proto__" key stays data.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item, depth + 1)]));
}

/**
 * Converts, strictly validates, and bounds the encoded size of one bridge
 * result. The converted value is returned rather than zod's copy, which drops
 * a JSONB `__proto__` key the owner bridge would return.
 */
export function toBridgeJson(value: unknown, maxBytes: number): BridgeJsonValue {
  const converted = convert(value, 0);
  if (!z.json().safeParse(converted).success) throw new BridgeJsonError("unsupported_type");
  if (Buffer.byteLength(JSON.stringify(converted), "utf8") > maxBytes) throw new BridgeJsonError("too_large");
  return converted;
}
