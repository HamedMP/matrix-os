import { createHash } from "node:crypto";
import { BotStateError } from "./shared.js";

/** Keys are sorted so equal actions hash equally regardless of property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function encodeCheckpointAction(value: Record<string, unknown>): { action: string; actionHash: string } {
  const action = canonicalJson(value);
  if (new TextEncoder().encode(action).byteLength > 4 * 1024) throw new BotStateError("too_large");
  return { action, actionHash: createHash("sha256").update(action).digest("hex") };
}
