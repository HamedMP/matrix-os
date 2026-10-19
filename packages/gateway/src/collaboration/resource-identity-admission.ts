/** Physical identity admission shared by resource reads and mutations. */
import type { Kysely, Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationResourceDriver } from "./resource-actions.js";
import { CollaborationResourceCatalog, ResourceCatalogError, type CatalogEntryRecord, type CatalogNamespace } from "./resource-catalog.js";

type Executor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;

/** Include cataloged ancestors: an unchanged child cannot authorize a replaced container. */
export async function assertResourceIdentity(
  catalog: CollaborationResourceCatalog,
  driver: Pick<CollaborationResourceDriver, "fingerprint">,
  namespace: CatalogNamespace,
  entry: CatalogEntryRecord | null,
  executor: Executor = catalog.db,
): Promise<void> {
  const seen = new Set<string>();
  for (const start of [namespace.root, entry]) {
    if (!start) continue;
    if (start.path.length > 4096) throw new ResourceCatalogError("not_found");
    const segments = start.path.split("/");
    for (let length = segments.length; length > 0; length--) {
      const current = length === segments.length ? start : await catalog.getLiveByPath({
        ownerId: namespace.ownerId, projectId: namespace.projectId, kind: "folder", path: segments.slice(0, length).join("/"),
      }, executor);
      if (!current) continue;
      if (seen.has(current.id)) break;
      if (seen.size >= 4096 || current.deletedAt || current.kind === "app"
        || current.ownerId !== namespace.ownerId || current.projectId !== namespace.projectId) {
        throw new ResourceCatalogError("not_found");
      }
      seen.add(current.id);
      const incarnation = await driver.fingerprint({ ownerId: current.ownerId, projectId: current.projectId, path: current.path });
      if (incarnation !== current.incarnation) throw new ResourceCatalogError("not_found");
    }
  }
}
