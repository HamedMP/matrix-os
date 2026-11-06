import { randomUUID } from "node:crypto";
import type { CollaborationProjectOverview } from "@matrix-os/contracts";
import { sql, type Kysely } from "kysely";
import type { CollaborationProjectGitSetup } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import type {
  ProjectInventoryMembershipEffect,
  ProjectInventoryItem,
  ProjectInventoryReference,
} from "./project-inventory.js";
import type { ProjectTransitionRecord } from "./project-transition.js";
import { ProjectOverviewError, readProjectOverview } from "./project-chat-routes.js";
import { appendMutationRecords, jsonb, OPERATION_RETENTION_MS, parseJson } from "./repository-shared.js";

const MAX_MEMBERSHIP_EFFECTS = 1_000;
const ScopeIdSchema = z.uuid();
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const UnshareResultSchema = z.object({
  scopeId: ScopeIdSchema,
  lifecycle: z.literal("private"),
  revision: z.number().int().nonnegative(),
}).strict();

interface InventoryResult {
  projectId: string;
  projectRevision: number;
  ownedItems: ProjectInventoryItem[];
  externalReferences: ProjectInventoryReference[];
  blockers: Array<{ kind: ProjectInventoryItem["kind"]; id: string; code: string }>;
  membershipEffects: ProjectInventoryMembershipEffect[];
  gitSetup?: CollaborationProjectGitSetup;
  inventoryHash: string;
  membershipHash: string;
  inventoryToken: string;
  expiresAt: string;
}

interface ProjectInventoryPort {
  preview(input: {
    ownerId: string;
    projectId: string;
    membershipEffects: readonly ProjectInventoryMembershipEffect[];
  }): Promise<InventoryResult>;
  verifyConfirmation(input: {
    ownerId: string;
    projectId: string;
    expectedRevision: number;
    inventoryHash: string;
    membershipHash: string;
    inventoryToken: string;
  }): Promise<unknown>;
}

interface ProjectTransitionPort {
  replayPreparation(input: {
    scopeId: string;
    requestedBy: string;
    clientRequestId: string;
    payloadHash: string;
  }): Promise<ProjectTransitionRecord | null>;
  prepare(input: {
    scopeId: string;
    ownerId: string;
    requestedBy: string;
    clientRequestId: string;
    payloadHash: string;
    expectedScopeRevision: number;
    inventoryRevision: number;
    inventoryHash: string;
    membershipHash: string;
    destinationAuthorityRuntimeId: string;
    destinationAuthorityGeneration: number;
  }): Promise<ProjectTransitionRecord>;
}

export class ProjectSharingError extends Error {
  constructor(public readonly code: "not_found" | "forbidden" | "conflict" | "resource_blocked" | "capacity" | "unavailable") {
    super("Whole-project sharing is unavailable");
    this.name = "ProjectSharingError";
  }
}

export function createProjectSharingService(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  inventory: ProjectInventoryPort;
  transitions: ProjectTransitionPort;
  resolveDestination(input: { scopeId: string; ownerId: string; projectId: string }): Promise<{
    runtimeId: string;
    authorityGeneration: number;
  }>;
  onPrepared?(transition: ProjectTransitionRecord): boolean;
  /** The owner's name for a project; without it the overview is unavailable, never a guess. */
  projectName?(ownerId: string, projectId: string): Promise<string | null>;
}) {
  async function preparePreview(scopeId: string, actorId: string) {
    const scope = await loadPreparationScope(options.db, scopeId, actorId);
    const membershipEffects = await deriveProjectMembershipEffects(options.db, scope.id, scope.owner_id);
    const inventory = await options.inventory.preview({
      ownerId: scope.owner_id,
      projectId: scope.resource_id,
      membershipEffects,
    });
    return { scope, inventory };
  }

  return {
    async read(input: { scopeId: string }) {
      const scopeId = ScopeIdSchema.parse(input.scopeId);
      try {
        const scope = await options.db.selectFrom("collaboration_scopes").selectAll()
          .where("id", "=", scopeId)
          .where("kind", "=", "project")
          .where("lifecycle", "in", ["shared", "archived"])
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (!scope) throw new ProjectSharingError("not_found");
        const resources = await options.db.selectFrom("collaboration_resource_bindings")
          .select(["resource_kind", "resource_id", "revision", "readiness", "incarnation"])
          .where("project_scope_id", "=", scope.id)
          .where("authority_runtime_id", "=", scope.authority_runtime_id)
          .where("authority_generation", "=", Number(scope.authority_generation))
          .orderBy("resource_kind", "asc")
          .orderBy("resource_id", "asc")
          .limit(100_001)
          .execute();
        if (resources.length > 100_000) throw new ProjectSharingError("capacity");
        return {
          id: scope.resource_id,
          scopeId: scope.id,
          status: scope.lifecycle === "archived" ? "archived" as const : "active" as const,
          resources: resources.map((resource) => ({
            kind: resource.resource_kind,
            id: resource.resource_id,
            revision: String(resource.revision),
            readiness: resource.readiness,
            ...(resource.incarnation ? { incarnation: resource.incarnation } : {}),
          })),
        };
      } catch (error: unknown) {
        if (error instanceof ProjectSharingError) throw error;
        console.warn("[collaboration-project] shared project projection failed", error instanceof Error ? error.name : "UnknownError");
        throw new ProjectSharingError("unavailable");
      }
    },

    /** The shared project as members see it: its name and the Chats they can open. */
    async overview(input: { scopeId: string }): Promise<CollaborationProjectOverview> {
      const projectName = options.projectName;
      if (!projectName) throw new ProjectSharingError("unavailable");
      try {
        return await readProjectOverview(options.db, { scopeId: ScopeIdSchema.parse(input.scopeId), projectName });
      } catch (error: unknown) {
        if (error instanceof ProjectOverviewError) throw new ProjectSharingError(error.code);
        console.warn("[collaboration-project] shared project overview failed", error instanceof Error ? error.name : "UnknownError");
        throw new ProjectSharingError("unavailable");
      }
    },

    async preview(input: { scopeId: string; actorId: string }) {
      const scopeId = ScopeIdSchema.parse(input.scopeId);
      const actorId = ActorIdSchema.parse(input.actorId);
      const { scope, inventory } = await preparePreview(scopeId, actorId);
      return {
        scopeId: scope.id,
        scopeRevision: Number(scope.revision),
        ...inventory,
      };
    },

    async confirm(input: {
      scopeId: string;
      actorId: string;
      clientRequestId: string;
      payloadHash: string;
      expectedScopeRevision: number;
      expectedProjectRevision: number;
      inventoryHash: string;
      membershipHash: string;
      inventoryToken: string;
    }): Promise<ProjectTransitionRecord> {
      const parsed = z.object({
        scopeId: ScopeIdSchema,
        actorId: ActorIdSchema,
        clientRequestId: z.uuid(),
        payloadHash: DigestSchema,
        expectedScopeRevision: z.number().int().nonnegative(),
        expectedProjectRevision: z.number().int().nonnegative(),
        inventoryHash: DigestSchema,
        membershipHash: DigestSchema,
        inventoryToken: z.string().min(64).max(4_096),
      }).strict().parse(input);
      const replay = await options.transitions.replayPreparation({
        scopeId: parsed.scopeId,
        requestedBy: parsed.actorId,
        clientRequestId: parsed.clientRequestId,
        payloadHash: parsed.payloadHash,
      });
      if (replay) return replay;
      const { scope, inventory } = await preparePreview(parsed.scopeId, parsed.actorId);
      if (Number(scope.revision) !== parsed.expectedScopeRevision
        || inventory.projectRevision !== parsed.expectedProjectRevision
        || inventory.inventoryHash !== parsed.inventoryHash
        || inventory.membershipHash !== parsed.membershipHash) {
        throw new ProjectSharingError("conflict");
      }
      if (inventory.blockers.length > 0) throw new ProjectSharingError("resource_blocked");
      await options.inventory.verifyConfirmation({
        ownerId: scope.owner_id,
        projectId: scope.resource_id,
        expectedRevision: parsed.expectedProjectRevision,
        inventoryHash: parsed.inventoryHash,
        membershipHash: parsed.membershipHash,
        inventoryToken: parsed.inventoryToken,
      });
      let destination;
      try {
        destination = z.object({
          runtimeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
          authorityGeneration: z.number().int().positive(),
        }).strict().parse(await options.resolveDestination({
          scopeId: scope.id,
          ownerId: scope.owner_id,
          projectId: scope.resource_id,
        }));
      } catch (error: unknown) {
        if (!(error instanceof z.ZodError)) {
          console.warn("[collaboration-project] destination unavailable", error instanceof Error ? error.name : "UnknownError");
        }
        throw new ProjectSharingError("unavailable");
      }
      const transition = await options.transitions.prepare({
        scopeId: scope.id,
        ownerId: scope.owner_id,
        requestedBy: parsed.actorId,
        clientRequestId: parsed.clientRequestId,
        payloadHash: parsed.payloadHash,
        expectedScopeRevision: parsed.expectedScopeRevision,
        inventoryRevision: parsed.expectedProjectRevision,
        inventoryHash: parsed.inventoryHash,
        membershipHash: parsed.membershipHash,
        destinationAuthorityRuntimeId: destination.runtimeId,
        destinationAuthorityGeneration: destination.authorityGeneration,
      });
      if (options.onPrepared && !options.onPrepared(transition)) {
        throw new ProjectSharingError("capacity");
      }
      return transition;
    },

    async unshare(input: {
      scopeId: string;
      actorId: string;
      clientRequestId: string;
      expectedRevision: number;
      payloadHash: string;
    }) {
      const parsed = z.object({
        scopeId: ScopeIdSchema,
        actorId: ActorIdSchema,
        clientRequestId: z.uuid(),
        expectedRevision: z.number().int().nonnegative(),
        payloadHash: DigestSchema,
      }).strict().parse(input);
      return options.db.transaction().execute(async (trx) => {
        const replay = await trx.selectFrom("collaboration_operations").selectAll()
          .where("scope_id", "=", parsed.scopeId)
          .where("actor_id", "=", parsed.actorId)
          .where("client_request_id", "=", parsed.clientRequestId)
          .where("operation_kind", "=", "project.unshare")
          .executeTakeFirst();
        if (replay) {
          if (replay.payload_hash !== parsed.payloadHash || replay.status !== "completed" || replay.result_ref === null) {
            throw new ProjectSharingError("conflict");
          }
          return UnshareResultSchema.parse(parseJson(replay.result_ref));
        }
        const scope = await trx.selectFrom("collaboration_scopes").selectAll()
          .where("id", "=", parsed.scopeId).where("kind", "=", "project")
          .where("deleted_at", "is", null).forUpdate().executeTakeFirst();
        if (!scope) throw new ProjectSharingError("not_found");
        const owner = await trx.selectFrom("collaboration_members").select(["role", "status"])
          .where("scope_id", "=", scope.id).where("actor_id", "=", parsed.actorId)
          .forUpdate().executeTakeFirst();
        if (scope.owner_id !== parsed.actorId || owner?.role !== "owner" || owner.status !== "accepted") {
          throw new ProjectSharingError("forbidden");
        }
        if (Number(scope.revision) !== parsed.expectedRevision
          || (scope.lifecycle !== "shared" && scope.lifecycle !== "archived")) {
          throw new ProjectSharingError("conflict");
        }
        const children = await trx.selectFrom("collaboration_scopes").select(["id", "lifecycle"])
          .where("parent_scope_id", "=", scope.id).where("membership_mode", "=", "inherited")
          .where("deleted_at", "is", null).forUpdate().execute();
        if (children.some((child) => child.lifecycle !== scope.lifecycle)) throw new ProjectSharingError("conflict");
        const committedDate = new Date();
        const committedAt = committedDate.toISOString();
        const revision = Number(scope.revision) + 1;
        const updated = await trx.updateTable("collaboration_scopes").set({
          lifecycle: "private", revision, auth_epoch: sql<number>`auth_epoch + 1`, updated_at: committedAt,
        }).where("id", "=", scope.id).where("revision", "=", parsed.expectedRevision)
          .where("lifecycle", "=", scope.lifecycle).returningAll().executeTakeFirst();
        if (!updated) throw new ProjectSharingError("conflict");
        if (children.length > 0) {
          await trx.updateTable("collaboration_scopes").set({
            lifecycle: "private", revision: sql<number>`revision + 1`, auth_epoch: sql<number>`auth_epoch + 1`, updated_at: committedAt,
          }).where("id", "in", children.map((child) => child.id)).execute();
        }
        const recipients = await trx.selectFrom("collaboration_members").select("actor_id")
          .where("scope_id", "=", scope.id).where("status", "=", "accepted").execute();
        await appendMutationRecords(trx, {
          scope: updated,
          actorId: parsed.actorId,
          action: "scope.unshared",
          now: committedAt,
          recipients: recipients.map((recipient) => ({ actorId: recipient.actor_id })),
          discoveryState: "revoked",
        });
        const result = UnshareResultSchema.parse({ scopeId: scope.id, lifecycle: "private", revision });
        await trx.insertInto("collaboration_operations").values({
          scope_id: scope.id, actor_id: parsed.actorId, client_request_id: parsed.clientRequestId,
          operation_kind: "project.unshare", payload_hash: parsed.payloadHash, status: "completed",
          result_ref: jsonb(result), expected_revision: parsed.expectedRevision,
          accepted_auth_epoch: Number(scope.auth_epoch), created_at: committedAt,
          expires_at: new Date(committedDate.getTime() + OPERATION_RETENTION_MS),
        }).execute();
        return result;
      });
    },
  };
}

async function loadPreparationScope(
  db: Kysely<OwnerCollaborationDatabase>,
  scopeId: string,
  actorId: string,
) {
  try {
    const scope = await db.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", scopeId)
      .where("kind", "=", "project")
      .where("membership_mode", "=", "direct")
      .where("lifecycle", "in", ["private", "preparing"])
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!scope) throw new ProjectSharingError("not_found");
    const owner = await db.selectFrom("collaboration_members").select(["role", "status"])
      .where("scope_id", "=", scope.id)
      .where("actor_id", "=", actorId)
      .executeTakeFirst();
    if (actorId !== scope.owner_id || owner?.role !== "owner" || owner.status !== "accepted") {
      throw new ProjectSharingError("forbidden");
    }
    return scope;
  } catch (error: unknown) {
    if (error instanceof ProjectSharingError) throw error;
    console.warn("[collaboration-project] preparation scope unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectSharingError("unavailable");
  }
}

export async function deriveProjectMembershipEffects(
  db: Kysely<OwnerCollaborationDatabase>,
  projectScopeId: string,
  ownerId: string,
): Promise<ProjectInventoryMembershipEffect[]> {
  try {
    const projectMembers = await db.selectFrom("collaboration_members")
      .select(["actor_id", "role"])
      .where("scope_id", "=", projectScopeId)
      .where("actor_id", "!=", ownerId)
      .where("status", "in", ["accepted", "pending"])
      .orderBy("actor_id", "asc")
      .limit(MAX_MEMBERSHIP_EFFECTS + 1)
      .execute();
    const childMembers = await db.selectFrom("collaboration_resource_bindings as binding")
      .innerJoin("collaboration_scopes as child", "child.id", "binding.resource_scope_id")
      .innerJoin("collaboration_members as member", "member.scope_id", "child.id")
      .select([
        "member.actor_id",
        "member.role",
        "binding.resource_kind",
        "binding.resource_id",
      ])
      .where("binding.project_scope_id", "=", projectScopeId)
      .where("binding.resource_kind", "in", ["chat", "terminal"])
      .where("child.membership_mode", "=", "direct")
      .where("member.actor_id", "!=", ownerId)
      .where("member.status", "in", ["accepted", "pending"])
      .orderBy("member.actor_id", "asc")
      .orderBy("binding.resource_kind", "asc")
      .orderBy("binding.resource_id", "asc")
      .limit(MAX_MEMBERSHIP_EFFECTS + 1)
      .execute();
    if (projectMembers.length + childMembers.length > MAX_MEMBERSHIP_EFFECTS) {
      throw new ProjectSharingError("capacity");
    }
    return [
      ...projectMembers.map((member) => ({
        actorId: member.actor_id,
        role: member.role === "owner" ? "editor" as const : member.role,
        effect: "join_project" as const,
      })),
      ...childMembers.map((member) => ({
        actorId: member.actor_id,
        role: member.role === "owner" ? "editor" as const : member.role,
        effect: "end_item_grant" as const,
        resourceKind: member.resource_kind as "chat" | "terminal",
        resourceId: member.resource_id,
      })),
    ];
  } catch (error: unknown) {
    if (error instanceof ProjectSharingError) throw error;
    console.warn("[collaboration-project] membership effects unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectSharingError("unavailable");
  }
}

export type ProjectSharingService = ReturnType<typeof createProjectSharingService>;
