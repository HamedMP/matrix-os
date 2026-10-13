import { createHash } from "node:crypto";

/** Presentation edits do not change execution authority. Unknown future fields
 * remain authority-bearing by default; exempt only the two explicit UI fields.
 * Canonical JSON also keeps schema normalization/key ordering out of equality. */
export function nativeCodexConfigurationFingerprint(row) {
  const execution = row && typeof row === "object" && !Array.isArray(row)
    ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== "displayName" && key !== "accentColor"))
    : row;
  return createHash("sha256").update(JSON.stringify(execution, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : value)).digest("hex");
}
