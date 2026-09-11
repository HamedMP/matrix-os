import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import {
  CanvasDocumentWriteSchema,
  CanvasIdSchema,
  CanvasNodeIdSchema,
  CanvasViewStateSchema,
  PatchCanvasNodeRequestSchema,
} from "../canvas/contracts.js";
import type { CanvasDatabase } from "../canvas/repository.js";
import {
  CollaborationAuthorizationError,
  type AuthorizedCollaborationContext,
} from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";

const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RequestIdSchema = z.uuid();
const ProjectRefSchema = z.object({ projectId: z.string().min(1).max(256) }).passthrough();
const ViewStateSchema = CanvasViewStateSchema.omit({ userId: true, updatedAt: true }).strict();
const PatchNodeSchema = z.object({
  canvasId: CanvasIdSchema,
  nodeId: CanvasNodeIdSchema,
  expectedNodeRevision: z.number().int().nonnegative(),
  clientRequestId: RequestIdSchema,
  updates: PatchCanvasNodeRequestSchema.shape.updates.strict(),
}).strict();
const PutViewStateSchema = z.object({
  canvasId: CanvasIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  clientRequestId: RequestIdSchema,
  state: ViewStateSchema,
}).strict();

export type ProjectLayoutDatabase = OwnerCollaborationDatabase & CanvasDatabase;

export interface ProjectLayoutProjection {
  layout: {
    canvasId: string;
    revision: number;
    nodes: unknown[];
    edges: unknown[];
    displayOptions: Record<string, unknown>;
  };
  viewState: (z.infer<typeof ViewStateSchema> & { revision: number }) | null;
}

export class ProjectLayoutAdapterError extends Error {
  constructor(public readonly code: "invalid" | "not_found" | "forbidden" | "conflict" | "unavailable") {
    super("Shared project layout is unavailable");
    this.name = "ProjectLayoutAdapterError";
  }
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapError(error: unknown): ProjectLayoutAdapterError {
  if (error instanceof ProjectLayoutAdapterError) return error;
  if (error instanceof CollaborationAuthorizationError) {
    return new ProjectLayoutAdapterError(error.code === "forbidden" ? "forbidden" : error.code === "not_found" ? "not_found" : "unavailable");
  }
  console.warn("[collaboration-project] project layout operation failed", error instanceof Error ? error.name : "UnknownError");
  return new ProjectLayoutAdapterError("unavailable");
}

export function createProjectLayoutAdapter(options: {
  db: Kysely<ProjectLayoutDatabase>;
  authority: {
    authorize(input: {
      scopeId: string;
      actorId: string;
      action: "read" | "mutate_project";
    }): Promise<AuthorizedCollaborationContext>;
  };
  now?: () => Date;
  createEventId?: () => string;
  onCommitted?(scopeId: string): Promise<void>;
}) {
  const now = options.now ?? (() => new Date());
  const createEventId = options.createEventId ?? randomUUID;

  function validateContext(context: AuthorizedCollaborationContext): void {
    if (context.resourceKind !== "project" || context.scopeId !== context.membershipScopeId) {
      throw new ProjectLayoutAdapterError("not_found");
    }
  }

  async function lockCurrent(
    trx: Transaction<ProjectLayoutDatabase>,
    context: AuthorizedCollaborationContext,
    requireWrite: boolean,
  ): Promise<{ ownerScope: "personal" | "org" }> {
    let scopeQuery = trx.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", context.scopeId);
    scopeQuery = requireWrite ? scopeQuery.forUpdate() : scopeQuery.forShare();
    const scope = await scopeQuery.executeTakeFirst();
    let memberQuery = trx.selectFrom("collaboration_members").selectAll()
      .where("scope_id", "=", context.membershipScopeId)
      .where("actor_id", "=", context.actorId);
    memberQuery = requireWrite ? memberQuery.forUpdate() : memberQuery.forShare();
    const member = await memberQuery.executeTakeFirst();
    const expired = member?.expires_at && new Date(member.expires_at).getTime() <= now().getTime();
    if (!scope || scope.kind !== "project" || scope.lifecycle !== "shared"
      || scope.resource_id !== context.resourceId || scope.owner_id !== context.ownerId
      || scope.authority_runtime_id !== context.authorityRuntimeId
      || Number(scope.authority_generation) !== context.authorityGeneration
      || Number(scope.auth_epoch) !== context.authEpoch
      || !member || member.status !== "accepted" || expired) {
      throw new ProjectLayoutAdapterError("not_found");
    }
    if (requireWrite && !["owner", "editor"].includes(member.role)) {
      throw new ProjectLayoutAdapterError("forbidden");
    }
    return { ownerScope: scope.owner_type === "personal" ? "personal" : "org" };
  }

  async function requireBinding(
    trx: Transaction<ProjectLayoutDatabase>,
    context: AuthorizedCollaborationContext,
    canvasId: string,
  ) {
    const binding = await trx.selectFrom("collaboration_resource_bindings").selectAll()
      .where("project_scope_id", "=", context.scopeId)
      .where("resource_kind", "=", "layout")
      .where("resource_id", "=", canvasId)
      .forUpdate().executeTakeFirst();
    if (!binding || binding.readiness !== "ready"
      || binding.authority_runtime_id !== context.authorityRuntimeId
      || Number(binding.authority_generation) !== context.authorityGeneration) {
      throw new ProjectLayoutAdapterError("unavailable");
    }
    return binding;
  }

  async function requireCanvas(
    trx: Transaction<ProjectLayoutDatabase>,
    context: AuthorizedCollaborationContext,
    canvasId: string,
    ownerScope: "personal" | "org",
    lock = false,
  ) {
    let query = trx.selectFrom("canvas_documents").selectAll()
      .where("id", "=", canvasId)
      .where("owner_scope", "=", ownerScope)
      .where("owner_id", "=", context.ownerId)
      .where("scope_type", "=", "project")
      .where("deleted_at", "is", null);
    if (lock) query = query.forUpdate();
    const canvas = await query.executeTakeFirst();
    if (!canvas) throw new ProjectLayoutAdapterError("not_found");
    const ref = ProjectRefSchema.safeParse(parseJson<unknown>(canvas.scope_ref));
    if (!ref.success || ref.data.projectId !== context.resourceId) {
      throw new ProjectLayoutAdapterError("not_found");
    }
    return canvas;
  }

  function validateDocument(canvas: {
    nodes: unknown;
    edges: unknown;
    display_options: unknown;
  }) {
    const document = CanvasDocumentWriteSchema.safeParse({
      schemaVersion: 1,
      nodes: parseJson<unknown>(canvas.nodes),
      edges: parseJson<unknown>(canvas.edges),
      viewStates: [],
      displayOptions: parseJson<unknown>(canvas.display_options),
    });
    if (!document.success) throw new ProjectLayoutAdapterError("unavailable");
    return document.data;
  }

  async function get(context: AuthorizedCollaborationContext, raw: { canvasId: string }): Promise<ProjectLayoutProjection> {
    const canvasId = CanvasIdSchema.safeParse(raw.canvasId);
    if (!canvasId.success) throw new ProjectLayoutAdapterError("invalid");
    try {
      validateContext(context);
      const current = await options.authority.authorize({
        scopeId: context.scopeId,
        actorId: context.actorId,
        action: "read",
      });
      return await options.db.transaction().execute(async (trx) => {
        const { ownerScope } = await lockCurrent(trx, current, false);
        await requireBinding(trx, current, canvasId.data);
        const canvas = await requireCanvas(trx, current, canvasId.data, ownerScope);
        const document = validateDocument(canvas);
        const ownState = await trx.selectFrom("collaboration_project_view_states")
          .select(["state", "revision"])
          .where("scope_id", "=", current.scopeId)
          .where("canvas_id", "=", canvasId.data)
          .where("actor_id", "=", current.actorId)
          .executeTakeFirst();
        const state = ownState ? ViewStateSchema.safeParse(parseJson<unknown>(ownState.state)) : null;
        if (state && !state.success) throw new ProjectLayoutAdapterError("unavailable");
        return {
          layout: {
            canvasId: canvas.id,
            revision: Number(canvas.revision),
            nodes: document.nodes,
            edges: document.edges,
            displayOptions: document.displayOptions,
          },
          viewState: ownState && state?.success
            ? { ...state.data, revision: Number(ownState.revision) }
            : null,
        };
      });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async function patchNode(context: AuthorizedCollaborationContext, raw: unknown): Promise<{
    nodeRevision: number;
    layoutRevision: number;
    replayed: boolean;
  }> {
    const input = PatchNodeSchema.safeParse(raw);
    if (!input.success) throw new ProjectLayoutAdapterError("invalid");
    try {
      validateContext(context);
      const current = await options.authority.authorize({
        scopeId: context.scopeId,
        actorId: context.actorId,
        action: "mutate_project",
      });
      const payloadHash = hash(input.data);
      const result = await options.db.transaction().execute(async (trx) => {
        const { ownerScope } = await lockCurrent(trx, current, true);
        const existing = await trx.selectFrom("collaboration_operations")
          .select(["payload_hash", "status", "result_ref"])
          .where("scope_id", "=", current.scopeId)
          .where("actor_id", "=", current.actorId)
          .where("client_request_id", "=", input.data.clientRequestId)
          .where("operation_kind", "=", "project.layout.node.patch")
          .executeTakeFirst();
        if (existing) {
          const replay = z.object({ nodeRevision: z.number(), layoutRevision: z.number() }).strict()
            .safeParse(parseJson<unknown>(existing.result_ref));
          if (existing.payload_hash !== payloadHash || existing.status !== "completed" || !replay.success) {
            throw new ProjectLayoutAdapterError("conflict");
          }
          return { ...replay.data, replayed: true };
        }
        const binding = await requireBinding(trx, current, input.data.canvasId);
        await requireCanvas(trx, current, input.data.canvasId, ownerScope, true);
        await trx.insertInto("collaboration_layout_node_revisions").values({
          scope_id: current.scopeId,
          canvas_id: input.data.canvasId,
          node_id: input.data.nodeId,
          revision: 0,
          updated_at: now(),
        }).onConflict((conflict) => conflict.doNothing()).execute();
        const nodeVersion = await trx.selectFrom("collaboration_layout_node_revisions").selectAll()
          .where("scope_id", "=", current.scopeId)
          .where("canvas_id", "=", input.data.canvasId)
          .where("node_id", "=", input.data.nodeId)
          .forUpdate().executeTakeFirstOrThrow();
        if (Number(nodeVersion.revision) !== input.data.expectedNodeRevision) {
          throw new ProjectLayoutAdapterError("conflict");
        }
        const patch = jsonb({ ...input.data.updates, updatedAt: now().toISOString() });
        const canvas = await trx.updateTable("canvas_documents").set({
          revision: sql<number>`revision + 1`,
          nodes: sql`
            jsonb_set(
              nodes,
              ARRAY[(
                SELECT (elem.idx - 1)::text
                FROM jsonb_array_elements(nodes) WITH ORDINALITY AS elem(node, idx)
                WHERE elem.node->>'id' = ${input.data.nodeId}
                LIMIT 1
              )],
              (
                SELECT elem.node || ${patch}
                FROM jsonb_array_elements(nodes) WITH ORDINALITY AS elem(node, idx)
                WHERE elem.node->>'id' = ${input.data.nodeId}
                LIMIT 1
              ),
              false
            )
          `,
          updated_at: now(),
        }).where("id", "=", input.data.canvasId)
          .where("owner_scope", "=", ownerScope)
          .where("owner_id", "=", current.ownerId)
          .where("scope_type", "=", "project")
          .where("deleted_at", "is", null)
          .where(sql<boolean>`EXISTS (
            SELECT 1 FROM jsonb_array_elements(nodes) AS elem(node)
            WHERE elem.node->>'id' = ${input.data.nodeId}
          )`)
          .returning(["revision", "nodes", "edges", "display_options"])
          .executeTakeFirst();
        if (!canvas) throw new ProjectLayoutAdapterError("not_found");
        validateDocument(canvas);
        const advanced = await trx.updateTable("collaboration_layout_node_revisions").set({
          revision: input.data.expectedNodeRevision + 1,
          updated_at: now(),
        }).where("scope_id", "=", current.scopeId)
          .where("canvas_id", "=", input.data.canvasId)
          .where("node_id", "=", input.data.nodeId)
          .where("revision", "=", input.data.expectedNodeRevision)
          .returning("revision").executeTakeFirst();
        if (!advanced) throw new ProjectLayoutAdapterError("conflict");
        const bindingRevision = Number(binding.revision) + 1;
        const changedBinding = await trx.updateTable("collaboration_resource_bindings").set({
          revision: bindingRevision,
          updated_at: now(),
        }).where("id", "=", binding.id).where("revision", "=", Number(binding.revision))
          .returning("id").executeTakeFirst();
        if (!changedBinding) throw new ProjectLayoutAdapterError("conflict");
        const response = {
          nodeRevision: Number(advanced.revision),
          layoutRevision: Number(canvas.revision),
        };
        await appendMutationRecords(trx, current, {
          clientRequestId: input.data.clientRequestId,
          operationKind: "project.layout.node.patch",
          payloadHash,
          expectedRevision: input.data.expectedNodeRevision,
          result: response,
          eventType: "project.layout.node_changed",
          eventPayload: { canvasId: input.data.canvasId, nodeId: input.data.nodeId },
          revision: bindingRevision,
        }, now(), createEventId());
        return { ...response, replayed: false };
      });
      await notify(options.onCommitted, current.scopeId, result.replayed);
      return result;
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async function putViewState(context: AuthorizedCollaborationContext, raw: unknown): Promise<{
    revision: number;
    replayed: boolean;
  }> {
    const input = PutViewStateSchema.safeParse(raw);
    if (!input.success) throw new ProjectLayoutAdapterError("invalid");
    try {
      validateContext(context);
      const current = await options.authority.authorize({
        scopeId: context.scopeId,
        actorId: context.actorId,
        action: "read",
      });
      const payloadHash = hash(input.data);
      return await options.db.transaction().execute(async (trx) => {
        const { ownerScope } = await lockCurrent(trx, current, false);
        await requireBinding(trx, current, input.data.canvasId);
        await requireCanvas(trx, current, input.data.canvasId, ownerScope);
        const existingOperation = await trx.selectFrom("collaboration_operations")
          .select(["payload_hash", "status", "result_ref"])
          .where("scope_id", "=", current.scopeId)
          .where("actor_id", "=", current.actorId)
          .where("client_request_id", "=", input.data.clientRequestId)
          .where("operation_kind", "=", "project.layout.view_state.put")
          .executeTakeFirst();
        if (existingOperation) {
          const replay = z.object({ revision: z.number().int().positive() }).strict()
            .safeParse(parseJson<unknown>(existingOperation.result_ref));
          if (existingOperation.payload_hash !== payloadHash || existingOperation.status !== "completed" || !replay.success) {
            throw new ProjectLayoutAdapterError("conflict");
          }
          return { revision: replay.data.revision, replayed: true };
        }
        const existing = await trx.selectFrom("collaboration_project_view_states").select("revision")
          .where("scope_id", "=", current.scopeId)
          .where("canvas_id", "=", input.data.canvasId)
          .where("actor_id", "=", current.actorId)
          .forUpdate().executeTakeFirst();
        let revision: number;
        if (!existing) {
          if (input.data.expectedRevision !== 0) throw new ProjectLayoutAdapterError("conflict");
          const created = await trx.insertInto("collaboration_project_view_states").values({
            scope_id: current.scopeId,
            canvas_id: input.data.canvasId,
            actor_id: current.actorId,
            state: jsonb(input.data.state),
            revision: 1,
            updated_at: now(),
          }).onConflict((conflict) => conflict.doNothing())
            .returning("revision").executeTakeFirst();
          if (!created) throw new ProjectLayoutAdapterError("conflict");
          revision = Number(created.revision);
        } else {
          if (Number(existing.revision) !== input.data.expectedRevision) {
            throw new ProjectLayoutAdapterError("conflict");
          }
          const updated = await trx.updateTable("collaboration_project_view_states").set({
            state: jsonb(input.data.state),
            revision: input.data.expectedRevision + 1,
            updated_at: now(),
          }).where("scope_id", "=", current.scopeId)
            .where("canvas_id", "=", input.data.canvasId)
            .where("actor_id", "=", current.actorId)
            .where("revision", "=", input.data.expectedRevision)
            .returning("revision").executeTakeFirst();
          if (!updated) throw new ProjectLayoutAdapterError("conflict");
          revision = Number(updated.revision);
        }
        const timestamp = now();
        await trx.insertInto("collaboration_operations").values({
          scope_id: current.scopeId,
          actor_id: current.actorId,
          client_request_id: input.data.clientRequestId,
          operation_kind: "project.layout.view_state.put",
          payload_hash: payloadHash,
          status: "completed",
          result_ref: jsonb({ revision }),
          expected_revision: input.data.expectedRevision,
          accepted_auth_epoch: current.authEpoch,
          created_at: timestamp,
          expires_at: new Date(timestamp.getTime() + OPERATION_RETENTION_MS),
        }).execute();
        return { revision, replayed: false };
      });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  return { get, patchNode, putViewState };
}

async function appendMutationRecords(
  trx: Transaction<ProjectLayoutDatabase>,
  context: AuthorizedCollaborationContext,
  input: {
    clientRequestId: string;
    operationKind: string;
    payloadHash: string;
    expectedRevision: number;
    result: unknown;
    eventType: string;
    eventPayload: unknown;
    revision: number;
  },
  timestamp: Date,
  eventId: string,
): Promise<void> {
  await trx.insertInto("collaboration_operations").values({
    scope_id: context.scopeId,
    actor_id: context.actorId,
    client_request_id: input.clientRequestId,
    operation_kind: input.operationKind,
    payload_hash: input.payloadHash,
    status: "completed",
    result_ref: jsonb(input.result),
    expected_revision: input.expectedRevision,
    accepted_auth_epoch: context.authEpoch,
    created_at: timestamp,
    expires_at: new Date(timestamp.getTime() + OPERATION_RETENTION_MS),
  }).execute();
  const latestEvent = await trx.selectFrom("collaboration_events")
    .select("scope_seq").where("scope_id", "=", context.scopeId)
    .orderBy("scope_seq", "desc").limit(1).executeTakeFirst();
  await trx.insertInto("collaboration_events").values({
    scope_id: context.scopeId,
    scope_seq: Number(latestEvent?.scope_seq ?? 0) + 1,
    event_id: z.uuid().parse(eventId),
    resource_kind: "project",
    resource_id: context.resourceId,
    revision: input.revision,
    authority_generation: context.authorityGeneration,
    event_type: input.eventType,
    payload: jsonb(input.eventPayload),
    created_at: timestamp,
  }).execute();
  await trx.insertInto("collaboration_audit").values({
    scope_id: context.scopeId,
    actor_id: context.actorId,
    action: input.operationKind,
    outcome: "completed",
    revision: input.revision,
    reason_code: null,
    created_at: timestamp,
  }).execute();
}

async function notify(
  onCommitted: ((scopeId: string) => Promise<void>) | undefined,
  scopeId: string,
  replayed: boolean,
): Promise<void> {
  if (!onCommitted || replayed) return;
  try {
    await onCommitted(scopeId);
  } catch (error: unknown) {
    console.warn("[collaboration-project] project layout event delivery failed", error instanceof Error ? error.name : "UnknownError");
  }
}
