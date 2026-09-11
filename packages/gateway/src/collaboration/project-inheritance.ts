import { randomUUID } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import { z } from "zod/v4";
import type {
  CollaborationResourceBindingsTable,
  OwnerCollaborationDatabase,
} from "./database.js";

const BindingIdSchema = z.uuid();
const ScopeIdSchema = z.uuid();
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ResourceKindSchema = z.enum(["file", "chat", "app", "layout", "terminal"]);
const ResourceIdSchema = z.string().min(1).max(4_096).regex(/^[^\0\r\n]+$/);
const IncarnationSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const BlockerSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]{0,79}$/);

type BindingRow = Selectable<CollaborationResourceBindingsTable>;
type CollaborationTransaction = Transaction<OwnerCollaborationDatabase>;

export interface ProjectResourceBinding {
  id: string;
  projectScopeId: string;
  membershipScopeId: string;
  resourceScopeId?: string;
  kind: "file" | "chat" | "app" | "layout" | "terminal";
  resourceId: string;
  authorityRuntimeId: string;
  authorityGeneration: number;
  revision: number;
  readiness: "ready" | "blocked";
  blocker?: string;
  incarnation?: string;
  createdAt: string;
  updatedAt: string;
}

export class ProjectInheritanceError extends Error {
  constructor(public readonly code:
    | "not_found"
    | "conflict"
    | "invalid_resource"
    | "resource_blocked"
    | "unavailable") {
    super("Project resource inheritance is unavailable");
    this.name = "ProjectInheritanceError";
  }
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToBinding(row: BindingRow): ProjectResourceBinding {
  return {
    id: row.id,
    projectScopeId: row.project_scope_id,
    membershipScopeId: row.project_scope_id,
    ...(row.resource_scope_id ? { resourceScopeId: row.resource_scope_id } : {}),
    kind: row.resource_kind,
    resourceId: row.resource_id,
    authorityRuntimeId: row.authority_runtime_id,
    authorityGeneration: Number(row.authority_generation),
    revision: Number(row.revision),
    readiness: row.readiness,
    ...(row.blocker ? { blocker: row.blocker } : {}),
    ...(row.incarnation ? { incarnation: row.incarnation } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function sameBinding(row: BindingRow, input: {
  projectScopeId: string;
  kind: ProjectResourceBinding["kind"];
  resourceId: string;
  authorityRuntimeId: string;
  authorityGeneration: number;
  revision: number;
  readiness: "ready" | "blocked";
  blocker?: string;
  incarnation?: string;
}): boolean {
  return row.project_scope_id === input.projectScopeId
    && row.resource_kind === input.kind
    && row.resource_id === input.resourceId
    && row.authority_runtime_id === input.authorityRuntimeId
    && Number(row.authority_generation) === input.authorityGeneration
    && Number(row.revision) === input.revision
    && row.readiness === input.readiness
    && (row.blocker ?? undefined) === input.blocker
    && (row.incarnation ?? undefined) === input.incarnation;
}

async function inheritedResourceScope(
  trx: CollaborationTransaction,
  input: {
    projectScopeId: string;
    ownerType: "personal" | "organization";
    ownerId: string;
    kind: "chat" | "terminal";
    resourceId: string;
    authorityRuntimeId: string;
    authorityGeneration: number;
    revision: number;
    lifecycle: "preparing" | "shared";
    now: Date;
    createScopeId: () => string;
  },
): Promise<string> {
  const existing = await trx.selectFrom("collaboration_scopes").selectAll()
    .where("owner_type", "=", input.ownerType)
    .where("owner_id", "=", input.ownerId)
    .where("kind", "=", input.kind)
    .where("resource_id", "=", input.resourceId)
    .where("deleted_at", "is", null)
    .where("lifecycle", "!=", "deleted")
    .executeTakeFirst();
  if (existing) {
    if (existing.membership_mode === "direct") {
      if (input.lifecycle !== "preparing" || existing.parent_scope_id !== null
        || (existing.lifecycle !== "private" && existing.lifecycle !== "shared")) {
        throw new ProjectInheritanceError("conflict");
      }
      // Publication reconciles this direct scope and its grants atomically.
      // Reserving the stable scope here must not widen or end membership early.
      return existing.id;
    }
    if (existing.parent_scope_id !== input.projectScopeId
      || existing.authority_runtime_id !== input.authorityRuntimeId
      || Number(existing.authority_generation) !== input.authorityGeneration) {
      throw new ProjectInheritanceError("conflict");
    }
    return existing.id;
  }

  const proposedId = ScopeIdSchema.parse(input.createScopeId());
  await trx.insertInto("collaboration_scopes").values({
    id: proposedId,
    owner_type: input.ownerType,
    owner_id: input.ownerId,
    kind: input.kind,
    resource_id: input.resourceId,
    parent_scope_id: input.projectScopeId,
    membership_mode: "inherited",
    lifecycle: input.lifecycle,
    revision: input.revision,
    auth_epoch: 0,
    authority_runtime_id: input.authorityRuntimeId,
    authority_generation: input.authorityGeneration,
    execution_generation: null,
    execution_eligibility: null,
    created_at: input.now,
    updated_at: input.now,
    deleted_at: null,
  }).onConflict((conflict) => conflict.doNothing()).execute();
  const winner = await trx.selectFrom("collaboration_scopes").selectAll()
    .where("owner_type", "=", input.ownerType)
    .where("owner_id", "=", input.ownerId)
    .where("kind", "=", input.kind)
    .where("resource_id", "=", input.resourceId)
    .where("deleted_at", "is", null)
    .where("lifecycle", "!=", "deleted")
    .executeTakeFirst();
  if (!winner || winner.membership_mode !== "inherited" || winner.parent_scope_id !== input.projectScopeId
    || winner.authority_runtime_id !== input.authorityRuntimeId
    || Number(winner.authority_generation) !== input.authorityGeneration) {
    throw new ProjectInheritanceError("conflict");
  }
  return winner.id;
}

export function createProjectInheritanceResolver(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  now?: () => Date;
  createBindingId?: () => string;
  createScopeId?: () => string;
}) {
  const now = options.now ?? (() => new Date());
  const createBindingId = options.createBindingId ?? randomUUID;
  const createScopeId = options.createScopeId ?? randomUUID;

  async function bindOwnedResource(raw: {
    projectScopeId: string;
    ownerId: string;
    kind: ProjectResourceBinding["kind"];
    resourceId: string;
    authorityRuntimeId: string;
    authorityGeneration: number;
    revision: number;
    readiness: "ready" | "blocked";
    blocker?: string;
    incarnation?: string;
  }): Promise<ProjectResourceBinding> {
    const parsed = z.object({
      projectScopeId: ScopeIdSchema,
      ownerId: ActorIdSchema,
      kind: ResourceKindSchema,
      resourceId: ResourceIdSchema,
      authorityRuntimeId: RuntimeIdSchema,
      authorityGeneration: z.number().int().positive(),
      revision: z.number().int().nonnegative(),
      readiness: z.enum(["ready", "blocked"]),
      blocker: BlockerSchema.optional(),
      incarnation: IncarnationSchema.optional(),
    }).strict().safeParse(raw);
    if (!parsed.success
      || (parsed.data.kind === "terminal" && !parsed.data.incarnation)
      || (parsed.data.kind === "file" && !safeRelativeFilePath(parsed.data.resourceId))
      || (parsed.data.kind !== "file" && parsed.data.resourceId.length > 256)
      || (parsed.data.readiness === "ready" && parsed.data.blocker)
      || (parsed.data.readiness === "blocked" && !parsed.data.blocker)) {
      throw new ProjectInheritanceError("invalid_resource");
    }
    const input = parsed.data;
    try {
      return await options.db.transaction().execute(async (trx) => {
        const project = await trx.selectFrom("collaboration_scopes").selectAll()
          .where("id", "=", input.projectScopeId).forUpdate().executeTakeFirst();
        if (!project || project.kind !== "project" || project.owner_id !== input.ownerId
          || project.membership_mode !== "direct"
          || (project.lifecycle !== "preparing" && project.lifecycle !== "shared")) {
          throw new ProjectInheritanceError("not_found");
        }
        if (project.lifecycle === "shared"
          && (project.authority_runtime_id !== input.authorityRuntimeId
            || Number(project.authority_generation) !== input.authorityGeneration)) {
          throw new ProjectInheritanceError("conflict");
        }
        const existing = await trx.selectFrom("collaboration_resource_bindings").selectAll()
          .where("project_scope_id", "=", input.projectScopeId)
          .where("resource_kind", "=", input.kind)
          .where("resource_id", "=", input.resourceId)
          .executeTakeFirst();
        if (existing) {
          if (!sameBinding(existing, input)) throw new ProjectInheritanceError("conflict");
          return rowToBinding(existing);
        }
        const resourceScopeId = input.kind === "chat" || input.kind === "terminal"
          ? await inheritedResourceScope(trx, {
              ...input,
              ownerType: project.owner_type,
              kind: input.kind,
              lifecycle: project.lifecycle,
              now: now(),
              createScopeId,
            })
          : null;
        const bindingId = BindingIdSchema.parse(createBindingId());
        const createdAt = now();
        await trx.insertInto("collaboration_resource_bindings").values({
          id: bindingId,
          project_scope_id: project.id,
          resource_scope_id: resourceScopeId,
          resource_kind: input.kind,
          resource_id: input.resourceId,
          authority_runtime_id: input.authorityRuntimeId,
          authority_generation: input.authorityGeneration,
          revision: input.revision,
          readiness: input.readiness,
          blocker: input.blocker ?? null,
          incarnation: input.incarnation ?? null,
          created_at: createdAt,
          updated_at: createdAt,
        }).onConflict((conflict) => conflict.doNothing()).execute();
        const winner = await trx.selectFrom("collaboration_resource_bindings").selectAll()
          .where("project_scope_id", "=", project.id)
          .where("resource_kind", "=", input.kind)
          .where("resource_id", "=", input.resourceId)
          .executeTakeFirst();
        if (!winner || !sameBinding(winner, input)
          || (resourceScopeId !== null && winner.resource_scope_id !== resourceScopeId)) {
          throw new ProjectInheritanceError("conflict");
        }
        return rowToBinding(winner);
      });
    } catch (error: unknown) {
      if (error instanceof ProjectInheritanceError) throw error;
      console.warn("[collaboration-project] inherited resource binding failed", error instanceof Error ? error.name : "UnknownError");
      throw new ProjectInheritanceError("unavailable");
    }
  }

  async function resolve(raw: {
    ownerId: string;
    kind: ProjectResourceBinding["kind"];
    resourceId: string;
  }): Promise<ProjectResourceBinding | null> {
    const input = z.object({
      ownerId: ActorIdSchema,
      kind: ResourceKindSchema,
      resourceId: ResourceIdSchema,
    }).strict().parse(raw);
    const row = await options.db.selectFrom("collaboration_resource_bindings as binding")
      .innerJoin("collaboration_scopes as project", "project.id", "binding.project_scope_id")
      .selectAll("binding")
      .where("project.owner_id", "=", input.ownerId)
      .where("project.kind", "=", "project")
      .where("project.deleted_at", "is", null)
      .where("project.lifecycle", "=", "shared")
      .where("binding.resource_kind", "=", input.kind)
      .where("binding.resource_id", "=", input.resourceId)
      .executeTakeFirst();
    return row ? rowToBinding(row) : null;
  }

  async function assertReadyForActivation(projectScopeId: string): Promise<void> {
    const scopeId = ScopeIdSchema.parse(projectScopeId);
    await options.db.transaction().execute(async (trx) => {
      const project = await trx.selectFrom("collaboration_scopes").select(["id", "kind", "lifecycle"])
        .where("id", "=", scopeId).forUpdate().executeTakeFirst();
      if (!project || project.kind !== "project"
        || (project.lifecycle !== "preparing" && project.lifecycle !== "recovering")) {
        throw new ProjectInheritanceError("not_found");
      }
      const blocked = await trx.selectFrom("collaboration_resource_bindings")
        .select("id").where("project_scope_id", "=", scopeId)
        .where("readiness", "=", "blocked").limit(1).executeTakeFirst();
      if (blocked) throw new ProjectInheritanceError("resource_blocked");
    });
  }

  return { bindOwnedResource, resolve, assertReadyForActivation };
}

function safeRelativeFilePath(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 4_096 || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
