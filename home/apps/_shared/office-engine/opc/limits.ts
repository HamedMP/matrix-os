/** Size limits applied to an untrusted archive before and during inflation. */

import type { ZipLimits } from "../api/opc.js";
import { fault } from "./errors.js";

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
});

function pick(name: keyof ZipLimits, value: number | undefined): number {
  if (value === undefined) return DEFAULT_ZIP_LIMITS[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw fault("invalid_value", `${name} must be a finite, non-negative number`);
  }
  return Math.floor(value);
}

export function resolveZipLimits(input?: Partial<ZipLimits>): ZipLimits {
  return {
    maxEntries: pick("maxEntries", input?.maxEntries),
    maxEntryBytes: pick("maxEntryBytes", input?.maxEntryBytes),
    maxTotalBytes: pick("maxTotalBytes", input?.maxTotalBytes),
  };
}
