import { createHash, randomUUID } from "node:crypto";
import { BridgeQueryBodySchema, type BridgeQueryBody } from "../app-db-contracts.js";
import { normalizeAppStorageSlug } from "../app-db-types.js";
import { type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import {
  CollaborationAuthorizationError,
  type AuthorizedCollaborationContext,
} from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";

const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const RequestIdSchema = z.uuid();
const ProjectAppRecordSchema = z.object({
  projectId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  appId: AppIdSchema,
  bridgeAppId: z.string().min(1).max(256),
  collaborationMode: z.enum(["scoped", "unavailable"]),
}).strict();
const MutationEnvelopeSchema = z.object({
  appId: AppIdSchema,
  clientRequestId: RequestIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  action: z.unknown(),
}).strict();

const READ_ACTIONS: readonly BridgeQueryBody["action"][] = ["find", "findOne", "count", "schema", "appInfo"];
const MUTATION_ACTIONS: readonly BridgeQueryBody["action"][] = ["insert", "bulkInsert", "update", "bulkUpdate", "delete"];

export interface ProjectAppBridge {
  execute(input: {
    namespace: string;
    scopeId: string;
    actorId: string;
    action: BridgeQueryBody;
    transaction?: Transaction<OwnerCollaborationDatabase>;
  }): Promise<unknown>;
}

export class ProjectAppAdapterError extends Error {
  constructor(public readonly code:
    | "invalid_action"
    | "not_found"
    | "forbidden"
    | "conflict"
    | "app_unavailable"
    | "unavailable") {
    super("Shared project app is unavailable");
    this.name = "ProjectAppAdapterError";
  }
}

function projectNamespace(scopeId: string, appId: string): string {
  return `p${createHash("sha256").update(scopeId).update("\0").update(appId).digest("hex").slice(0, 32)}`;
}

function jsonValue(value: unknown): unknown {
  const parsed = z.json().safeParse(value);
  if (!parsed.success) throw new ProjectAppAdapterError("unavailable");
  const encoded = JSON.stringify(parsed.data);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) {
    throw new ProjectAppAdapterError("unavailable");
  }
  return parsed.data;
}

function jsonb(value: unknown) {
  return JSON.stringify(value) as unknown as object;
}

function parseStoredResult(value: unknown): { result: unknown; revision: number } {
  const parsed = z.object({
    result: z.json(),
    revision: z.number().int().nonnegative(),
  }).strict().safeParse(typeof value === "string" ? JSON.parse(value) : value);
  if (!parsed.success) throw new ProjectAppAdapterError("conflict");
  return parsed.data;
}

function mapError(error: unknown): ProjectAppAdapterError {
  if (error instanceof ProjectAppAdapterError) return error;
  if (error instanceof CollaborationAuthorizationError) {
    return new ProjectAppAdapterError(error.code === "forbidden" ? "forbidden" : error.code === "not_found" ? "not_found" : "unavailable");
  }
  console.warn("[collaboration-project] project app operation failed", error instanceof Error ? error.name : "UnknownError");
  return new ProjectAppAdapterError("unavailable");
}

export function createProjectAppAdapter(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  authority: {
    authorize(input: {
      scopeId: string;
      actorId: string;
      action: "read" | "mutate_project";
    }): Promise<AuthorizedCollaborationContext>;
  };
  apps: {
    resolve(projectId: string, appId: string): Promise<unknown>;
  };
  bridge: ProjectAppBridge;
  now?: () => Date;
  createEventId?: () => string;
  onCommitted?(scopeId: string): Promise<void>;
}) {
  const now = options.now ?? (() => new Date());
  const createEventId = options.createEventId ?? randomUUID;

  async function resolveApp(context: AuthorizedCollaborationContext, appId: string) {
    if (context.resourceKind !== "project" || context.scopeId !== context.membershipScopeId) {
      throw new ProjectAppAdapterError("not_found");
    }
    const app = ProjectAppRecordSchema.safeParse(await options.apps.resolve(context.resourceId, appId));
    if (!app.success || app.data.projectId !== context.resourceId || app.data.appId !== appId) {
      throw new ProjectAppAdapterError("not_found");
    }
    if (app.data.collaborationMode !== "scoped") throw new ProjectAppAdapterError("app_unavailable");
    const bridgeAppId = normalizeAppStorageSlug(app.data.bridgeAppId);
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(bridgeAppId)) throw new ProjectAppAdapterError("app_unavailable");
    return { app: app.data, bridgeAppId, namespace: projectNamespace(context.scopeId, appId) };
  }

  function parseAction(raw: unknown, expectedApp: string, allowed: readonly BridgeQueryBody["action"][]): BridgeQueryBody {
    const parsed = BridgeQueryBodySchema.safeParse(raw);
    if (!parsed.success || !allowed.includes(parsed.data.action) || parsed.data.action === "listApps"
      || !("app" in parsed.data) || parsed.data.app !== expectedApp) {
      throw new ProjectAppAdapterError("invalid_action");
    }
    return parsed.data;
  }

  async function requireCurrentProject(
    trx: Transaction<OwnerCollaborationDatabase>,
    context: AuthorizedCollaborationContext,
    requireWrite: boolean,
  ): Promise<void> {
    const scope = await trx.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", context.scopeId).forUpdate().executeTakeFirst();
    const member = await trx.selectFrom("collaboration_members").selectAll()
      .where("scope_id", "=", context.membershipScopeId)
      .where("actor_id", "=", context.actorId).forUpdate().executeTakeFirst();
    const expired = member?.expires_at && new Date(member.expires_at).getTime() <= now().getTime();
    if (!scope || scope.kind !== "project" || scope.lifecycle !== "shared"
      || scope.resource_id !== context.resourceId || scope.owner_id !== context.ownerId
      || scope.authority_runtime_id !== context.authorityRuntimeId
      || Number(scope.authority_generation) !== context.authorityGeneration
      || Number(scope.auth_epoch) !== context.authEpoch
      || !member || member.status !== "accepted" || expired) {
      throw new ProjectAppAdapterError("not_found");
    }
    if (requireWrite && !["owner", "editor"].includes(member.role)) {
      throw new ProjectAppAdapterError("forbidden");
    }
  }

  async function requireBinding(
    executor: Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>,
    context: AuthorizedCollaborationContext,
    appId: string,
    lock = false,
  ) {
    let query = executor.selectFrom("collaboration_resource_bindings").selectAll()
      .where("project_scope_id", "=", context.scopeId)
      .where("resource_kind", "=", "app")
      .where("resource_id", "=", appId);
    if (lock) query = query.forUpdate();
    const binding = await query.executeTakeFirst();
    if (!binding || binding.readiness !== "ready"
      || binding.authority_runtime_id !== context.authorityRuntimeId
      || Number(binding.authority_generation) !== context.authorityGeneration) {
      throw new ProjectAppAdapterError("app_unavailable");
    }
    return binding;
  }

  async function query(context: AuthorizedCollaborationContext, raw: {
    appId: string;
    action: unknown;
  }): Promise<unknown> {
    const appId = AppIdSchema.safeParse(raw.appId);
    if (!appId.success) throw new ProjectAppAdapterError("invalid_action");
    try {
      const current = await options.authority.authorize({
        scopeId: context.scopeId,
        actorId: context.actorId,
        action: "read",
      });
      if (current.resourceKind !== "project" || current.resourceId !== context.resourceId) {
        throw new ProjectAppAdapterError("not_found");
      }
      const app = await resolveApp(current, appId.data);
      const action = parseAction(raw.action, app.bridgeAppId, READ_ACTIONS);
      return await options.db.transaction().execute(async (trx) => {
        await requireCurrentProject(trx, current, false);
        await requireBinding(trx, current, appId.data, true);
        return jsonValue(await options.bridge.execute({
          namespace: app.namespace,
          scopeId: current.scopeId,
          actorId: current.actorId,
          action: { ...action, app: app.namespace } as BridgeQueryBody,
          transaction: trx,
        }));
      });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async function mutate(context: AuthorizedCollaborationContext, raw: unknown): Promise<{
    result: unknown;
    revision: number;
    replayed: boolean;
  }> {
    const envelope = MutationEnvelopeSchema.safeParse(raw);
    if (!envelope.success) throw new ProjectAppAdapterError("invalid_action");
    try {
      const current = await options.authority.authorize({
        scopeId: context.scopeId,
        actorId: context.actorId,
        action: "mutate_project",
      });
      if (current.resourceKind !== "project" || current.resourceId !== context.resourceId) {
        throw new ProjectAppAdapterError("not_found");
      }
      const app = await resolveApp(current, envelope.data.appId);
      const action = parseAction(envelope.data.action, app.bridgeAppId, MUTATION_ACTIONS);
      const payloadHash = createHash("sha256").update(JSON.stringify(envelope.data)).digest("hex");
      const committed = await options.db.transaction().execute(async (trx) => {
        await requireCurrentProject(trx, current, true);
        const existing = await trx.selectFrom("collaboration_operations")
          .select(["payload_hash", "status", "result_ref"])
          .where("scope_id", "=", current.scopeId)
          .where("actor_id", "=", current.actorId)
          .where("client_request_id", "=", envelope.data.clientRequestId)
          .where("operation_kind", "=", `project.app.${action.action}`)
          .executeTakeFirst();
        if (existing) {
          if (existing.payload_hash !== payloadHash || existing.status !== "completed" || existing.result_ref === null) {
            throw new ProjectAppAdapterError("conflict");
          }
          return { ...parseStoredResult(existing.result_ref), replayed: true };
        }
        const binding = await requireBinding(trx, current, envelope.data.appId, true);
        if (Number(binding.revision) !== envelope.data.expectedRevision) {
          throw new ProjectAppAdapterError("conflict");
        }
        const result = jsonValue(await options.bridge.execute({
          namespace: app.namespace,
          scopeId: current.scopeId,
          actorId: current.actorId,
          action: { ...action, app: app.namespace } as BridgeQueryBody,
          transaction: trx,
        }));
        const revision = Number(binding.revision) + 1;
        const changed = await trx.updateTable("collaboration_resource_bindings").set({
          revision,
          updated_at: now(),
        }).where("id", "=", binding.id).where("revision", "=", Number(binding.revision))
          .returning("id").executeTakeFirst();
        if (!changed) throw new ProjectAppAdapterError("conflict");
        const replayResult = { result, revision };
        const timestamp = now();
        await trx.insertInto("collaboration_operations").values({
          scope_id: current.scopeId,
          actor_id: current.actorId,
          client_request_id: envelope.data.clientRequestId,
          operation_kind: `project.app.${action.action}`,
          payload_hash: payloadHash,
          status: "completed",
          result_ref: jsonb(replayResult),
          expected_revision: envelope.data.expectedRevision,
          accepted_auth_epoch: current.authEpoch,
          created_at: timestamp,
          expires_at: new Date(timestamp.getTime() + OPERATION_RETENTION_MS),
        }).execute();
        const latestEvent = await trx.selectFrom("collaboration_events")
          .select("scope_seq").where("scope_id", "=", current.scopeId)
          .orderBy("scope_seq", "desc").limit(1).executeTakeFirst();
        await trx.insertInto("collaboration_events").values({
          scope_id: current.scopeId,
          scope_seq: Number(latestEvent?.scope_seq ?? 0) + 1,
          event_id: z.uuid().parse(createEventId()),
          resource_kind: "project",
          resource_id: current.resourceId,
          revision,
          authority_generation: current.authorityGeneration,
          event_type: "project.app.changed",
          payload: jsonb({ appId: envelope.data.appId, action: action.action }),
          created_at: timestamp,
        }).execute();
        await trx.insertInto("collaboration_audit").values({
          scope_id: current.scopeId,
          actor_id: current.actorId,
          action: `project.app.${action.action}`,
          outcome: "completed",
          revision,
          reason_code: null,
          created_at: timestamp,
        }).execute();
        return { ...replayResult, replayed: false };
      });
      if (!committed.replayed && options.onCommitted) {
        try {
          await options.onCommitted(current.scopeId);
        } catch (error: unknown) {
          console.warn("[collaboration-project] project app event delivery failed", error instanceof Error ? error.name : "UnknownError");
        }
      }
      return committed;
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  return { query, mutate };
}
