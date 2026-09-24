/**
 * S12 / T061, T064: app instances behind a collaboration scope. A project
 * scope reaches its bound apps through the existing project app adapter; a
 * standalone app scope reaches exactly the catalog entry it was created for.
 * Reads and mutations go through the owner's app bridge under a namespace
 * derived from the scope, never the app's own storage slug, so a viewer
 * cannot reach the owner's data through any other bridge path.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod/v4";
import { BridgeQueryBodySchema, type BridgeQueryBody } from "../app-db-contracts.js";
import { normalizeAppStorageSlug } from "../app-db-types.js";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext, type CollaborationAuthority } from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import {
  ProjectAppAdapterError,
  createProjectAppAdapter,
  type ProjectAppBridge,
} from "./project-app-adapter.js";
import { CollaborationResourceCatalog, ResourceCatalogError, type CatalogEntryRecord } from "./resource-catalog.js";

const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const AppRecordSchema = z.object({
  projectId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).nullable(),
  appId: AppIdSchema,
  bridgeAppId: z.string().min(1).max(256),
  collaborationMode: z.enum(["scoped", "unavailable"]),
  incarnation: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const EnvelopeSchema = z.object({
  clientRequestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  action: z.unknown(),
}).strict();
const READ_ACTIONS: readonly BridgeQueryBody["action"][] = ["find", "findOne", "count", "schema", "appInfo"];
const MUTATION_ACTIONS: readonly BridgeQueryBody["action"][] = ["insert", "bulkInsert", "update", "bulkUpdate", "delete"];

export interface AppInstanceDescription {
  appId: string;
  catalogId?: string;
  revision: number;
  readiness: "ready" | "blocked" | "unavailable";
  collaborationMode: "scoped" | "unavailable";
  incarnation: string;
  /** Where the app's static assets live for the asset route. */
  assetNamespace: { ownerId: string; projectId: string | null };
}

export interface AppInstanceAdapter {
  describe(context: AuthorizedCollaborationContext, appId: string): Promise<AppInstanceDescription>;
  query(context: AuthorizedCollaborationContext, appId: string, action: unknown): Promise<unknown>;
  mutate(context: AuthorizedCollaborationContext, appId: string, envelope: unknown): Promise<{ result: unknown; revision: number; replayed: boolean }>;
}

function standaloneNamespace(scopeId: string, appId: string): string {
  return `s${createHash("sha256").update(scopeId).update("\0").update(appId).digest("hex").slice(0, 32)}`;
}

function jsonValue(value: unknown): unknown {
  const parsed = z.json().safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAX_RESULT_BYTES) {
    throw new ProjectAppAdapterError("unavailable");
  }
  return parsed.data;
}

function jsonb(value: unknown) {
  return JSON.stringify(value) as unknown as object;
}

function parseAction(raw: unknown, expectedApp: string, allowed: readonly BridgeQueryBody["action"][]): BridgeQueryBody {
  const parsed = BridgeQueryBodySchema.safeParse(raw);
  if (!parsed.success || !allowed.includes(parsed.data.action) || parsed.data.action === "listApps"
    || !("app" in parsed.data) || parsed.data.app !== expectedApp) {
    throw new ProjectAppAdapterError("invalid_action");
  }
  return parsed.data;
}

function mapError(error: unknown): ProjectAppAdapterError {
  if (error instanceof ProjectAppAdapterError) return error;
  if (error instanceof ResourceCatalogError) {
    return new ProjectAppAdapterError(error.code === "invalid" ? "invalid_action" : error.code);
  }
  if (error instanceof CollaborationAuthorizationError) {
    return new ProjectAppAdapterError(error.code === "forbidden" ? "forbidden" : error.code === "not_found" ? "not_found" : "unavailable");
  }
  console.warn("[collaboration-app-instance] operation failed", error instanceof Error ? error.name : "UnknownError");
  return new ProjectAppAdapterError("unavailable");
}

export function createAppInstanceAdapter(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  authority: Pick<CollaborationAuthority, "authorize">;
  bridge: ProjectAppBridge;
  catalog: CollaborationResourceCatalog;
  apps: { resolve(projectId: string | null, appId: string): Promise<unknown> };
  now?: () => Date;
  createEventId?: () => string;
  onCommitted?(scopeId: string): Promise<void>;
}): AppInstanceAdapter {
  const now = options.now ?? (() => new Date());
  const createEventId = options.createEventId ?? randomUUID;
  const project = createProjectAppAdapter({
    db: options.db,
    authority: options.authority,
    apps: { resolve: (projectId, appId) => options.apps.resolve(projectId, appId) },
    bridge: options.bridge,
    now,
    createEventId,
    ...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
  });

  async function resolveApp(projectId: string | null, appId: string) {
    const record = AppRecordSchema.safeParse(await options.apps.resolve(projectId, appId));
    if (!record.success || record.data.appId !== appId || record.data.projectId !== projectId) {
      throw new ProjectAppAdapterError("not_found");
    }
    const bridgeAppId = normalizeAppStorageSlug(record.data.bridgeAppId);
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(bridgeAppId)) throw new ProjectAppAdapterError("app_unavailable");
    return { record: record.data, bridgeAppId };
  }

  async function standaloneRoot(context: AuthorizedCollaborationContext, appId: string): Promise<CatalogEntryRecord> {
    const namespace = await options.catalog.namespaceForScope(context);
    if (!namespace.root || namespace.root.kind !== "app" || namespace.root.path !== appId) {
      throw new ProjectAppAdapterError("not_found");
    }
    return namespace.root;
  }

  /** The scope row must still be the one the context was authorized against; the row lock serializes writers. */
  async function requireLiveScope(trx: Transaction<OwnerCollaborationDatabase>, context: AuthorizedCollaborationContext, forWrite: boolean) {
    let query = trx.selectFrom("collaboration_scopes").selectAll().where("id", "=", context.scopeId).where("deleted_at", "is", null);
    query = forWrite ? query.forUpdate() : query.forShare();
    const scope = await query.executeTakeFirst();
    if (!scope || scope.kind !== "app" || scope.lifecycle !== "shared" || scope.resource_id !== context.resourceId
      || scope.owner_id !== context.ownerId || scope.authority_runtime_id !== context.authorityRuntimeId
      || Number(scope.authority_generation) !== context.authorityGeneration
      || Number(scope.auth_epoch) !== context.authEpoch) {
      throw new ProjectAppAdapterError("not_found");
    }
    const member = await trx.selectFrom("collaboration_members").select(["status", "role", "expires_at"])
      .where("scope_id", "=", context.membershipScopeId).where("actor_id", "=", context.actorId)
      .forShare().executeTakeFirst();
    if (member && (member.status !== "accepted"
      || (member.expires_at && new Date(member.expires_at).getTime() <= now().getTime()))) {
      throw new ProjectAppAdapterError("not_found");
    }
    if (forWrite && (context.role === "viewer" || member?.role === "viewer")) throw new ProjectAppAdapterError("forbidden");
  }

  async function describe(context: AuthorizedCollaborationContext, rawAppId: string): Promise<AppInstanceDescription> {
    const appId = AppIdSchema.safeParse(rawAppId);
    if (!appId.success) throw new ProjectAppAdapterError("invalid_action");
    try {
      const current = await options.authority.authorize({ scopeId: context.scopeId, actorId: context.actorId, action: "read" });
      if (current.resourceKind === "project") {
        const binding = await options.db.selectFrom("collaboration_resource_bindings").selectAll()
          .where("project_scope_id", "=", current.scopeId).where("resource_kind", "=", "app").where("resource_id", "=", appId.data)
          .executeTakeFirst();
        if (!binding) throw new ProjectAppAdapterError("not_found");
        const { record } = await resolveApp(current.resourceId, appId.data);
        const stale = binding.authority_runtime_id !== current.authorityRuntimeId || Number(binding.authority_generation) !== current.authorityGeneration;
        if (!binding.incarnation || binding.incarnation !== record.incarnation) throw new ProjectAppAdapterError("app_unavailable");
        return {
          appId: appId.data,
          revision: Number(binding.revision),
          readiness: stale ? "unavailable" : binding.readiness,
          collaborationMode: record.collaborationMode,
          incarnation: record.incarnation,
          assetNamespace: { ownerId: current.ownerId, projectId: current.resourceId },
        };
      }
      const root = await standaloneRoot(current, appId.data);
      const { record } = await resolveApp(root.projectId, appId.data);
      if (root.incarnation !== record.incarnation) throw new ProjectAppAdapterError("app_unavailable");
      return {
        appId: appId.data,
        catalogId: root.id,
        revision: root.revision,
        readiness: "ready",
        collaborationMode: record.collaborationMode,
        incarnation: record.incarnation,
        assetNamespace: { ownerId: root.ownerId, projectId: root.projectId },
      };
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async function query(context: AuthorizedCollaborationContext, rawAppId: string, action: unknown): Promise<unknown> {
    if (context.resourceKind === "project") {
      const instance = await describe(context, rawAppId);
      if (instance.readiness !== "ready" || instance.collaborationMode !== "scoped") throw new ProjectAppAdapterError("app_unavailable");
      return project.query(context, { appId: rawAppId, action });
    }
    const appId = AppIdSchema.safeParse(rawAppId);
    if (!appId.success) throw new ProjectAppAdapterError("invalid_action");
    try {
      const current = await options.authority.authorize({ scopeId: context.scopeId, actorId: context.actorId, action: "read" });
      const root = await standaloneRoot(current, appId.data);
      const { record, bridgeAppId } = await resolveApp(root.projectId, appId.data);
      if (record.collaborationMode !== "scoped" || root.incarnation !== record.incarnation) throw new ProjectAppAdapterError("app_unavailable");
      const parsed = parseAction(action, bridgeAppId, READ_ACTIONS);
      const namespace = standaloneNamespace(current.scopeId, appId.data);
      return await options.db.transaction().execute(async (trx) => {
        await requireLiveScope(trx, current, false);
        if (!await options.catalog.get(root.id, trx)) throw new ProjectAppAdapterError("not_found");
        return jsonValue(await options.bridge.execute({
          namespace, appId: appId.data, storageSchema: bridgeAppId, scopeId: current.scopeId, actorId: current.actorId,
          action: { ...parsed, app: namespace } as BridgeQueryBody, transaction: trx,
        }));
      });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async function mutate(context: AuthorizedCollaborationContext, rawAppId: string, raw: unknown) {
    if (context.resourceKind === "project") {
      const instance = await describe(context, rawAppId);
      if (instance.readiness !== "ready" || instance.collaborationMode !== "scoped") throw new ProjectAppAdapterError("app_unavailable");
      return project.mutate(context, { ...(typeof raw === "object" && raw ? raw : {}), appId: rawAppId });
    }
    const appId = AppIdSchema.safeParse(rawAppId);
    const envelope = EnvelopeSchema.safeParse(raw);
    if (!appId.success || !envelope.success) throw new ProjectAppAdapterError("invalid_action");
    try {
      const current = await options.authority.authorize({ scopeId: context.scopeId, actorId: context.actorId, action: "mutate_resource" });
      const root = await standaloneRoot(current, appId.data);
      const { record, bridgeAppId } = await resolveApp(root.projectId, appId.data);
      if (record.collaborationMode !== "scoped" || root.incarnation !== record.incarnation) throw new ProjectAppAdapterError("app_unavailable");
      const parsed = parseAction(envelope.data.action, bridgeAppId, MUTATION_ACTIONS);
      const namespace = standaloneNamespace(current.scopeId, appId.data);
      const operationKind = `resource.app.${parsed.action}`;
      const payloadHash = createHash("sha256").update(JSON.stringify({ appId: appId.data, ...envelope.data })).digest("hex");
      const committed = await options.db.transaction().execute(async (trx) => {
        await requireLiveScope(trx, current, true);
        const existing = await trx.selectFrom("collaboration_operations").select(["payload_hash", "status", "result_ref"])
          .where("scope_id", "=", current.scopeId).where("actor_id", "=", current.actorId)
          .where("client_request_id", "=", envelope.data.clientRequestId).where("operation_kind", "=", operationKind).executeTakeFirst();
        if (existing) {
          const stored = z.object({ result: z.json(), revision: z.number().int().nonnegative() }).strict()
            .safeParse(typeof existing.result_ref === "string" ? JSON.parse(existing.result_ref) : existing.result_ref);
          if (existing.payload_hash !== payloadHash || existing.status !== "completed" || !stored.success) throw new ProjectAppAdapterError("conflict");
          return { ...stored.data, replayed: true };
        }
        const locked = await options.catalog.lock(trx, root.id);
        if (locked.revision !== envelope.data.expectedRevision) throw new ProjectAppAdapterError("conflict");
        const result = jsonValue(await options.bridge.execute({
          namespace, appId: appId.data, storageSchema: bridgeAppId, scopeId: current.scopeId, actorId: current.actorId,
          action: { ...parsed, app: namespace } as BridgeQueryBody, transaction: trx,
        }));
        const bumped = await options.catalog.bump(trx, { id: root.id, expectedRevision: locked.revision });
        const timestamp = now();
        const replay = { result, revision: bumped.revision };
        await trx.insertInto("collaboration_operations").values({
          scope_id: current.scopeId, actor_id: current.actorId, client_request_id: envelope.data.clientRequestId,
          operation_kind: operationKind, payload_hash: payloadHash, status: "completed", result_ref: jsonb(replay),
          expected_revision: envelope.data.expectedRevision, accepted_auth_epoch: current.authEpoch,
          created_at: timestamp, expires_at: new Date(timestamp.getTime() + OPERATION_RETENTION_MS),
        }).execute();
        const latest = await trx.selectFrom("collaboration_events").select("scope_seq").where("scope_id", "=", current.scopeId)
          .orderBy("scope_seq", "desc").limit(1).executeTakeFirst();
        await trx.insertInto("collaboration_events").values({
          scope_id: current.scopeId, scope_seq: Number(latest?.scope_seq ?? 0) + 1, event_id: z.uuid().parse(createEventId()),
          resource_kind: "app", resource_id: root.id, revision: bumped.revision, authority_generation: current.authorityGeneration,
          event_type: "resource.app.changed", payload: jsonb({ appId: appId.data, action: parsed.action }), created_at: timestamp,
        }).execute();
        await trx.insertInto("collaboration_audit").values({
          scope_id: current.scopeId, actor_id: current.actorId, action: operationKind, outcome: "completed",
          revision: bumped.revision, reason_code: null, created_at: timestamp,
        }).execute();
        return { ...replay, replayed: false };
      });
      if (!committed.replayed && options.onCommitted) {
        try {
          await options.onCommitted(current.scopeId);
        } catch (error: unknown) {
          console.warn("[collaboration-app-instance] event delivery failed", error instanceof Error ? error.name : "UnknownError");
        }
      }
      return committed;
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  return { describe, query, mutate };
}
