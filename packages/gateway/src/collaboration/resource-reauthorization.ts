/** Explicit owner recovery of existing owner resource shares; never creates authority. */
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationResourceDriver } from "./resource-actions.js";
import { CollaborationResourceCatalog, ResourceCatalogError, type CatalogEntryRecord } from "./resource-catalog.js";

export const COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION = createHash("sha256")
  .update("matrix-owner-reauthorization-required-v1").digest("hex");
const MAX_DESCENDANTS = 10_000;
// A valid 4096-character relative path has at most 2048 nonempty segments.
const MAX_RESOURCE_PATH_CHARACTERS = 4096;
const MAX_ANCESTORS = MAX_RESOURCE_PATH_CHARACTERS / 2;
type TransactionDb = Transaction<OwnerCollaborationDatabase>;
export interface OwnerResourceReauthorizationInput {
  ownerId: string; runtimeId: string; organizationId: string; scopeId: string; resourceId: string;
  kind: "file" | "folder"; authorityGeneration?: number;
}
export interface OwnerResourceReauthorizationConfirmation extends OwnerResourceReauthorizationInput {
  projectId: string | null; expectedRevision: string; currentIncarnation: string; confirmCurrentObject: true;
}

export function createOwnerResourceReauthorization(options: {
  catalog: CollaborationResourceCatalog;
  driver: Pick<CollaborationResourceDriver, "inspect">;
}) {
  const { catalog, driver } = options;
  async function scopeEntry(trx: TransactionDb, input: OwnerResourceReauthorizationInput, locked: boolean) {
    let query = trx.selectFrom("collaboration_scopes").selectAll().where("id", "=", input.scopeId);
    if (locked) query = query.forUpdate();
    const scope = await query.executeTakeFirst();
    if (!scope || scope.deleted_at !== null || scope.owner_type !== "personal" || scope.owner_id !== input.ownerId
      || scope.organization_id !== input.organizationId || (scope.kind !== "project" && scope.kind !== "file" && scope.kind !== "folder")
      || scope.parent_scope_id !== null || scope.membership_mode !== "direct"
      || (scope.lifecycle !== "shared" && !(scope.kind === "project" && scope.lifecycle === "private"))
      || scope.authority_runtime_id !== input.runtimeId) throw new ResourceCatalogError("not_found");
    if (input.authorityGeneration !== undefined && Number(scope.authority_generation) !== input.authorityGeneration) {
      throw new ResourceCatalogError("conflict");
    }
    const member = await trx.selectFrom("collaboration_members").select(["role", "status", "expires_at", "organization_id"])
      .where("scope_id", "=", scope.id).where("actor_id", "=", input.ownerId).executeTakeFirst();
    if (!member || member.role !== "owner" || member.status !== "accepted" || member.organization_id !== input.organizationId
      || (member.expires_at !== null && new Date(member.expires_at).getTime() <= Date.now())) throw new ResourceCatalogError("forbidden");
    const namespace = await catalog.namespaceForScope({ ownerId: input.ownerId, resourceKind: scope.kind, resourceId: scope.resource_id }, trx);
    const entry = await catalog.get(input.resourceId, trx);
    // Existing standalone roots may depend on an unshared catalog ancestor. The
    // owner can explicitly recover that folder without creating a broader share.
    const ancestor = entry?.kind === "folder" && namespace.root !== null
      && (namespace.root.kind === "file" || namespace.root.kind === "folder")
      && entry.ownerId === namespace.ownerId && entry.projectId === namespace.projectId
      && namespace.root.path.startsWith(`${entry.path}/`);
    if (!entry || entry.kind !== input.kind || (!catalog.contains(namespace, entry) && !ancestor)) throw new ResourceCatalogError("not_found");
    return entry;
  }
  async function physical(entry: CatalogEntryRecord): Promise<string> {
    if (!driver.inspect) throw new ResourceCatalogError("unavailable");
    const { incarnation } = await driver.inspect({ ownerId: entry.ownerId, projectId: entry.projectId, kind: entry.kind, path: entry.path });
    if (!/^[a-f0-9]{64}$/.test(incarnation) || incarnation === COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION) {
      throw new ResourceCatalogError("unavailable");
    }
    return incarnation;
  }
  async function currentParents(trx: TransactionDb, entry: CatalogEntryRecord): Promise<void> {
    if (entry.path.length > MAX_RESOURCE_PATH_CHARACTERS) throw new ResourceCatalogError("unavailable");
    const paths: string[] = [];
    for (let offset = entry.path.indexOf("/"); offset !== -1; offset = entry.path.indexOf("/", offset + 1)) {
      paths.push(entry.path.slice(0, offset));
      if (paths.length > MAX_ANCESTORS) throw new ResourceCatalogError("unavailable");
    }
    if (!paths.length) return;
    // One indexed namespace/path lookup replaces a round trip per path segment.
    const parents = await trx.selectFrom("collaboration_resource_catalog").select(["path", "incarnation"])
      .where("owner_id", "=", entry.ownerId).where("project_id", entry.projectId === null ? "is" : "=", entry.projectId)
      .where("kind", "=", "folder").where("deleted_at", "is", null).where("path", "in", paths).orderBy("path").execute();
    for (const parent of parents) {
      const current = await physical({ ...entry, kind: "folder", path: parent.path });
      if (current !== parent.incarnation) throw new ResourceCatalogError("conflict");
    }
  }
  async function descendants(trx: TransactionDb, entry: CatalogEntryRecord): Promise<{ id: string; revision: number | string }[]> {
    const escaped = entry.path.replace(/[\\%_]/g, "\\$&");
    const query = trx.selectFrom("collaboration_resource_catalog").select(["id", "revision"])
      .where("owner_id", "=", entry.ownerId).where("project_id", entry.projectId === null ? "is" : "=", entry.projectId)
      .where("deleted_at", "is", null).where("kind", "in", ["file", "folder"])
      .where("path", "like", `${escaped}/%`).orderBy("id").limit(MAX_DESCENDANTS + 1).forUpdate();
    const rows = await query.execute();
    if (rows.length > MAX_DESCENDANTS) throw new ResourceCatalogError("unavailable");
    return rows;
  }
  return {
    async inspect(input: OwnerResourceReauthorizationInput) {
      return catalog.db.transaction().execute(async (trx) => {
        const initial = await scopeEntry(trx, input, false);
        await catalog.lockNamespace(trx, initial, "shared");
        const entry = await scopeEntry(trx, input, false);
        await currentParents(trx, entry);
        return { scopeId: input.scopeId, organizationId: input.organizationId, resourceId: entry.id, kind: input.kind,
          path: entry.path, projectId: entry.projectId, expectedRevision: String(entry.revision), currentIncarnation: await physical(entry) };
      });
    },
    async confirm(input: OwnerResourceReauthorizationConfirmation) {
      if (input.confirmCurrentObject !== true || !/^[a-f0-9]{64}$/.test(input.currentIncarnation)
        || input.currentIncarnation === COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION
        || !/^(0|[1-9][0-9]*)$/.test(input.expectedRevision)
        || !Number.isSafeInteger(Number(input.expectedRevision)) || Number(input.expectedRevision) >= Number.MAX_SAFE_INTEGER) {
        throw new ResourceCatalogError("invalid");
      }
      return catalog.db.transaction().execute(async (trx) => {
        const initial = await scopeEntry(trx, input, true);
        await catalog.lockNamespace(trx, initial, "exclusive");
        const entry = await catalog.lock(trx, initial.id);
        // A path may have changed while waiting for the namespace lock. Bind
        // the current catalog row and standalone root again under that lock.
        await scopeEntry(trx, input, false);
        if (entry.projectId !== input.projectId || entry.revision !== Number(input.expectedRevision)) throw new ResourceCatalogError("conflict");
        await currentParents(trx, entry);
        if (await physical(entry) !== input.currentIncarnation) throw new ResourceCatalogError("conflict");
        if (entry.incarnation === input.currentIncarnation) return entry;
        const children = entry.kind === "folder" ? await descendants(trx, entry) : [];
        if (children.some(child => !Number.isSafeInteger(Number(child.revision)) || Number(child.revision) >= Number.MAX_SAFE_INTEGER)) {
          throw new ResourceCatalogError("unavailable");
        }
        const result = await catalog.bump(trx, { id: entry.id, expectedRevision: entry.revision, incarnation: input.currentIncarnation });
        if (children.length) await trx.updateTable("collaboration_resource_catalog").set({
          incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION,
          revision: sql<number>`revision + 1`, updated_at: new Date(),
        }).where("id", "in", children.map(child => child.id)).where("deleted_at", "is", null).execute();
        await trx.insertInto("collaboration_audit").values({ scope_id: input.scopeId, actor_id: input.ownerId,
          action: "resource.reauthorize", outcome: "completed", revision: result.revision,
          detail: { catalogId: entry.id, kind: entry.kind, descendantsInvalidated: children.length },
          reason_code: null, created_at: new Date(),
        }).execute();
        return result;
      });
    },
  };
}
