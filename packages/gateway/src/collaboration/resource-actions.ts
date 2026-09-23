/**
 * S12 / T061: file and folder mutations on the home. Every action runs in one
 * transaction: replay by client request id, catalog row lock, conditional
 * revision bump, then the operation, event and audit rows. The filesystem
 * side effect happens after the locks and checks and before commit; a failed
 * commit after a successful driver write leaves a file ahead of its catalog
 * revision, which the next write reconciles through the incarnation.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod/v4";
import type { CollaborationFileActionRequest } from "@matrix-os/contracts";
import type { AuthorizedCollaborationContext } from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import { CollaborationResourceCatalog, ResourceCatalogError, type CatalogEntryRecord } from "./resource-catalog.js";

const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
type Namespace = { ownerId: string; projectId: string | null };
type FileAction = Extract<CollaborationFileActionRequest, { type: "write" | "create" | "rename" | "delete" }>;

export interface CollaborationResourceDriver {
  read(input: Namespace & { path: string }): Promise<{ stream: ReadableStream<Uint8Array>; size: number; contentType?: string }>;
  write(input: Namespace & { path: string; content: Uint8Array }): Promise<void>;
  /**
   * Atomic write of a large file the caller never holds whole: the bytes land
   * only when the stream delivered exactly `size` bytes hashing to `sha256`.
   */
  writeChunks(input: Namespace & { path: string; size: number; sha256: string; chunks: AsyncIterable<Uint8Array> }): Promise<void>;
  remove(input: Namespace & { path: string; kind: "file" | "folder" }): Promise<void>;
  rename(input: Namespace & { from: string; to: string }): Promise<void>;
  mkdir(input: Namespace & { path: string }): Promise<void>;
  /** Opaque incarnation fingerprint of the current bytes; changes on every write. */
  fingerprint(input: Namespace & { path: string }): Promise<string>;
  readAppAsset(input: Namespace & { appId: string; assetPath: string }): Promise<{ stream: ReadableStream<Uint8Array>; size: number; contentType?: string }>;
}

export interface FileActionResult {
  entry: CatalogEntryRecord;
  replayed: boolean;
}

function jsonb(value: unknown) {
  return JSON.stringify(value) as unknown as object;
}

const StoredResultSchema = z.object({ entryId: z.uuid(), revision: z.number().int().nonnegative() }).strict();

export function createFileActionExecutor(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  catalog: CollaborationResourceCatalog;
  driver: CollaborationResourceDriver;
  now?: () => Date;
  createEventId?: () => string;
}) {
  const now = options.now ?? (() => new Date());
  const createEventId = options.createEventId ?? randomUUID;

  async function lockScope(trx: Transaction<OwnerCollaborationDatabase>, context: AuthorizedCollaborationContext) {
    const scope = await trx.selectFrom("collaboration_scopes").selectAll().where("id", "=", context.scopeId)
      .where("deleted_at", "is", null).forUpdate().executeTakeFirst();
    if (!scope || scope.lifecycle !== "shared" || scope.resource_id !== context.resourceId || scope.owner_id !== context.ownerId
      || scope.authority_runtime_id !== context.authorityRuntimeId || Number(scope.authority_generation) !== context.authorityGeneration
      || Number(scope.auth_epoch) !== context.authEpoch) {
      throw new ResourceCatalogError("not_found");
    }
    const member = await trx.selectFrom("collaboration_members").select(["status", "role", "expires_at"])
      .where("scope_id", "=", context.membershipScopeId).where("actor_id", "=", context.actorId)
      .forShare().executeTakeFirst();
    if (member && (member.status !== "accepted" || member.role === "viewer"
      || (member.expires_at && new Date(member.expires_at).getTime() <= now().getTime()))) {
      throw new ResourceCatalogError("forbidden");
    }
    return scope;
  }

  async function record(
    trx: Transaction<OwnerCollaborationDatabase>,
    context: AuthorizedCollaborationContext,
    input: { operationKind: string; clientRequestId: string; payloadHash: string; expectedRevision: number; entry: CatalogEntryRecord; action: string },
  ): Promise<void> {
    const timestamp = now();
    await trx.insertInto("collaboration_operations").values({
      scope_id: context.scopeId, actor_id: context.actorId, client_request_id: input.clientRequestId,
      operation_kind: input.operationKind, payload_hash: input.payloadHash, status: "completed",
      result_ref: jsonb({ entryId: input.entry.id, revision: input.entry.revision }),
      expected_revision: input.expectedRevision, accepted_auth_epoch: context.authEpoch,
      created_at: timestamp, expires_at: new Date(timestamp.getTime() + OPERATION_RETENTION_MS),
    }).execute();
    const latest = await trx.selectFrom("collaboration_events").select("scope_seq").where("scope_id", "=", context.scopeId)
      .orderBy("scope_seq", "desc").limit(1).executeTakeFirst();
    const projectScope = context.resourceKind === "project";
    await trx.insertInto("collaboration_events").values({
      scope_id: context.scopeId, scope_seq: Number(latest?.scope_seq ?? 0) + 1, event_id: z.uuid().parse(createEventId()),
      resource_kind: projectScope ? "project" : context.resourceKind, resource_id: projectScope ? context.resourceId : input.entry.id,
      revision: input.entry.revision, authority_generation: context.authorityGeneration, event_type: "resource.changed",
      payload: jsonb({ catalogId: input.entry.id, kind: input.entry.kind, action: input.action }), created_at: timestamp,
    }).execute();
    await trx.insertInto("collaboration_audit").values({
      scope_id: context.scopeId, actor_id: context.actorId, action: input.operationKind, outcome: "completed",
      revision: input.entry.revision, reason_code: null, created_at: timestamp,
    }).execute();
  }

  async function replay(
    trx: Transaction<OwnerCollaborationDatabase>,
    context: AuthorizedCollaborationContext,
    operationKind: string,
    clientRequestId: string,
    payloadHash: string,
  ): Promise<FileActionResult | null> {
    const existing = await trx.selectFrom("collaboration_operations").select(["payload_hash", "status", "result_ref"])
      .where("scope_id", "=", context.scopeId).where("actor_id", "=", context.actorId)
      .where("client_request_id", "=", clientRequestId).where("operation_kind", "=", operationKind).executeTakeFirst();
    if (!existing) return null;
    const stored = StoredResultSchema.safeParse(typeof existing.result_ref === "string" ? JSON.parse(existing.result_ref) : existing.result_ref);
    if (existing.payload_hash !== payloadHash || existing.status !== "completed" || !stored.success) throw new ResourceCatalogError("conflict");
    const entry = await options.catalog.getAny(stored.data.entryId, trx);
    if (!entry) throw new ResourceCatalogError("conflict");
    return { entry, replayed: true };
  }

  /** Runs one mutation; the caller has already authorized `mutate_resource`/`mutate_project` on the context. */
  async function execute(context: AuthorizedCollaborationContext, action: FileAction): Promise<FileActionResult> {
    const operationKind = `resource.${action.type}`;
    const payloadHash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    const expectedRevision = action.type === "create" ? 0 : Number(action.expectedRevision);
    return options.db.transaction().execute(async (trx) => {
      await lockScope(trx, context);
      const replayed = await replay(trx, context, operationKind, action.clientRequestId, payloadHash);
      if (replayed) return replayed;
      const namespace = await options.catalog.namespaceForScope(context, trx);
      const ns: Namespace = { ownerId: namespace.ownerId, projectId: namespace.projectId };
      // Path shape is namespace-wide, and the scope lock above only covers this
      // scope: a delete and a create of one of its descendants arrive through
      // different scope rows. Creates and writes share the namespace with each
      // other; a rename or delete takes it alone, because those two rewrite the
      // paths of descendants they never read, and a folder delete destroys their
      // bytes. Every read below runs after this lock, so a create that waits
      // behind a delete then resolves its parent as a tombstone, and a write that
      // waits behind one cannot put bytes back where the tree used to be.
      const shared = action.type === "create" || action.type === "write";
      await options.catalog.lockNamespace(trx, namespace, shared ? "shared" : "exclusive");
      let entry: CatalogEntryRecord;
      if (action.type === "create") {
        const created = await options.catalog.createWithin(context, {
          kind: action.kind, parentId: action.parentId, path: action.path, incarnation: "pending",
        }, trx);
        if (action.kind === "folder") await options.driver.mkdir({ ...ns, path: action.path });
        else await options.driver.write({ ...ns, path: action.path, content: new TextEncoder().encode(action.content ?? "") });
        // A created entry commits at revision 1: revision 0 is the catalog row before the bytes exist.
        entry = await options.catalog.bump(trx, { id: created.id, expectedRevision: 0, incarnation: await options.driver.fingerprint({ ...ns, path: action.path }) });
      } else {
        const resolved = await options.catalog.resolveForScope(context, action.fileId, trx);
        const locked = await options.catalog.lock(trx, resolved.id);
        if (locked.revision !== expectedRevision) throw new ResourceCatalogError("conflict");
        if (action.type === "write") {
          if (locked.kind !== "file") throw new ResourceCatalogError("invalid");
          await options.driver.write({ ...ns, path: locked.path, content: new TextEncoder().encode(action.content) });
          entry = await options.catalog.bump(trx, { id: locked.id, expectedRevision, incarnation: await options.driver.fingerprint({ ...ns, path: locked.path }) });
        } else if (action.type === "rename") {
          if (namespace.root && namespace.root.id === locked.id) throw new ResourceCatalogError("forbidden");
          if (namespace.root && !action.path.startsWith(`${namespace.root.path}/`)) throw new ResourceCatalogError("not_found");
          await options.driver.rename({ ...ns, from: locked.path, to: action.path });
          entry = await options.catalog.rename({ id: locked.id, path: action.path, expectedRevision, incarnation: locked.incarnation, executor: trx });
        } else {
          if (namespace.root && namespace.root.id === locked.id) throw new ResourceCatalogError("forbidden");
          // Admit the folder before the recursive filesystem delete: a bound that
          // first fired inside the catalog would roll the rows back over lost bytes.
          // The namespace lock above is what makes this count final.
          await options.catalog.assertFolderRemovable(locked, trx);
          await options.driver.remove({ ...ns, path: locked.path, kind: locked.kind === "folder" ? "folder" : "file" });
          entry = await options.catalog.remove({ id: locked.id, expectedRevision, executor: trx });
        }
      }
      await record(trx, context, { operationKind, clientRequestId: action.clientRequestId, payloadHash, expectedRevision, entry, action: action.type });
      return { entry, replayed: false };
    });
  }

  return { execute };
}
