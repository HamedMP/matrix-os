/** Stable registration identity; a new registry row at the same slug is a new app. */
import { createHash } from "node:crypto";

export function appRegistryIncarnation(record: { slug: string; created_at: string | Date }): string {
  const createdAt = record.created_at instanceof Date ? record.created_at.toISOString() : record.created_at;
  if (!record.slug || !createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("App registration identity unavailable");
  }
  return createHash("sha256").update(record.slug).update("\0").update(createdAt).digest("hex");
}
