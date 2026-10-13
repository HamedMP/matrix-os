import { createHash } from "node:crypto";

/** Canonical JSON keeps schema normalization/key ordering out of consent equality. */
export function nativeCodexConfigurationFingerprint(row) {
  return createHash("sha256").update(JSON.stringify(row, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : value)).digest("hex");
}
