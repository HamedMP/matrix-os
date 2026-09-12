import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import type {
  ProjectInventoryMembershipEffect,
  ProjectInventoryItem,
  ProjectInventoryReference,
} from "./project-inventory.js";
import type { ProjectTransitionRecord } from "./project-transition.js";

const MAX_MEMBERSHIP_EFFECTS = 1_000;
const ScopeIdSchema = z.uuid();
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

interface InventoryResult {
  projectId: string;
  projectRevision: number;
  ownedItems: ProjectInventoryItem[];
  externalReferences: ProjectInventoryReference[];
  blockers: Array<{ kind: ProjectInventoryItem["kind"]; id: string; code: string }>;
  membershipEffects: ProjectInventoryMembershipEffect[];
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
}) {
  async function preparePreview(scopeId: string, actorId: string) {
    const scope = await loadPreparationScope(options.db, scopeId, actorId);
    const membershipEffects = await deriveMembershipEffects(options.db, scope.id, scope.owner_id);
    const inventory = await options.inventory.preview({
      ownerId: scope.owner_id,
      projectId: scope.resource_id,
      membershipEffects,
    });
    return { scope, inventory };
  }

  return {
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
      return options.transitions.prepare({
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

async function deriveMembershipEffects(
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
