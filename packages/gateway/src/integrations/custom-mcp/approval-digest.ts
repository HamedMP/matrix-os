import { createHash } from "node:crypto";

const MAX_DEPTH = 16;
const MAX_BYTES = 64 * 1024;

function canonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) throw new Error("Custom MCP arguments are too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Custom MCP arguments are not finite JSON");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new Error("Custom MCP arguments are not JSON");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonical(item, depth + 1, seen)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("Custom MCP arguments are not plain JSON");
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1, seen)}`
    ).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Hash exactly the parsed JSON arguments that will be sent to the remote tool. */
export function customMcpArgumentsDigest(args: Record<string, unknown> | undefined): string {
  const encoded = canonical(args ?? {}, 0, new Set());
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) {
    throw new Error("Custom MCP arguments are too large");
  }
  return createHash("sha256").update("matrix-custom-mcp-args:v1\0").update(encoded).digest("hex");
}
