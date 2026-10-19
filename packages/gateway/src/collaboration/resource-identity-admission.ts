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
  destinationPath?: string,
): Promise<void> {
  const seen = new Set<string>();
  const starts = [namespace.root, entry].filter((value): value is CatalogEntryRecord => value !== null);
  const candidates: { path: string; entry: CatalogEntryRecord | null; includeSelf: boolean }[] =
    starts.map(start => ({ path: start.path, entry: start, includeSelf: true }));
  if (destinationPath !== undefined) candidates.push({ path: destinationPath, entry: null, includeSelf: false });
  for (const candidate of candidates) {
    if (candidate.path.length > 4096) throw new ResourceCatalogError("not_found");
    const segments = candidate.path.split("/");
    for (let length = segments.length - (candidate.includeSelf ? 0 : 1); length > 0; length--) {
      const current = candidate.includeSelf && length === segments.length ? candidate.entry : await catalog.getLiveByPath({
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
