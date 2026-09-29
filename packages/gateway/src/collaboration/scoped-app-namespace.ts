/** Shared app data keys stay bound to one scope and one registered app. */
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";

export function scopedAppNamespace(scopeId: string, appId: string, kind: "project" | "standalone"): string {
  return `${kind === "project" ? "p" : "s"}${createHash("sha256").update(scopeId).update("\0").update(appId).digest("hex").slice(0, 32)}`;
}

/** Call in the transaction that marks a share deleted, after its scope lock. */
export async function removeScopedAppData(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
  appIds: readonly string[],
  kind: "project" | "standalone",
): Promise<void> {
  if (appIds.length === 0) return;
  for (let start = 0; start < appIds.length; start += 500) {
    const namespaces = appIds.slice(start, start + 500)
      .map((appId) => scopedAppNamespace(scopeId, appId, kind));
    await sql`DELETE FROM public._kv WHERE app IN (${sql.join(namespaces)})`.execute(trx);
  }
}
