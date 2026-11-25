/**
 * Size limits applied to an untrusted archive before and during inflation.
 *
 * The defaults fit the 10 MiB file the product accepts: such a file of
 * ordinary office content inflates to a few tens of MiB, and a part of more
 * than 32 MiB is not something a reader can hold as a tree anyway. A caller
 * with other needs passes its own limits.
 */

import type { ZipLimits } from "../api/opc.js";
import { fault } from "./errors.js";

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
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
