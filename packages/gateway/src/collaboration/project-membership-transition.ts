import type { Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";

const MAX_PROJECT_RESOURCE_SCOPES = 100_000;
const MAX_DIRECT_SCOPE_MEMBERS = 8;

type CollaborationTransaction = Transaction<OwnerCollaborationDatabase>;

export class ProjectMembershipTransitionError extends Error {
  constructor(public readonly code: "conflict" | "capacity") {
    super("Project membership transition is unavailable");
    this.name = "ProjectMembershipTransitionError";
  }
}

/**
 * Replaces standalone Chat/terminal grants with the parent project's sole
 * membership authority. The caller already holds the project scope lock and
 * invokes this inside the same transaction as publication.
 */
export async function reconcileProjectMembershipAtPublication(
  trx: CollaborationTransaction,
  input: {
    projectScopeId: string;
    ownerType: "personal" | "organization";
    ownerId: string;
    requestedBy: string;
    destinationAuthorityRuntimeId: string;
    destinationAuthorityGeneration: number;
    now: Date;
    createEventId: () => string;
  },
): Promise<void> {
  const children = await trx.selectFrom("collaboration_resource_bindings as binding")
    .innerJoin("collaboration_scopes as child", "child.id", "binding.resource_scope_id")
    .select([
      "child.id",
      "child.owner_type",
      "child.owner_id",
      "child.kind",
      "child.resource_id",
      "child.parent_scope_id",
      "child.membership_mode",
      "child.lifecycle",
      "child.revision",
      "child.auth_epoch",
      "child.authority_runtime_id",
      "child.authority_generation",
      "child.deleted_at",
      "binding.resource_kind",
      "binding.resource_id as binding_resource_id",
    ])
    .where("binding.project_scope_id", "=", input.projectScopeId)
    .where("binding.resource_kind", "in", ["chat", "terminal"])
    .orderBy("child.id", "asc")
    .limit(MAX_PROJECT_RESOURCE_SCOPES + 1)
    .forUpdate("child")
    .execute();
  if (children.length > MAX_PROJECT_RESOURCE_SCOPES) {
    throw new ProjectMembershipTransitionError("capacity");
  }

  for (const child of children) {
    if (child.owner_type !== input.ownerType
      || child.owner_id !== input.ownerId
      || child.kind !== child.resource_kind
      || child.resource_id !== child.binding_resource_id
      || child.deleted_at !== null
      || child.lifecycle === "deleted"
      || (child.kind !== "chat" && child.kind !== "terminal")) {
      throw new ProjectMembershipTransitionError("conflict");
    }

    const members = await trx.selectFrom("collaboration_members")
      .selectAll()
      .where("scope_id", "=", child.id)
      .orderBy("actor_id", "asc")
      .limit(MAX_DIRECT_SCOPE_MEMBERS + 1)
      .forUpdate()
      .execute();
    if (members.length > MAX_DIRECT_SCOPE_MEMBERS) {
      throw new ProjectMembershipTransitionError("capacity");
    }

    if (child.membership_mode === "inherited") {
      if (child.parent_scope_id !== input.projectScopeId || members.length > 0
        || (child.lifecycle !== "preparing" && child.lifecycle !== "recovering")) {
        throw new ProjectMembershipTransitionError("conflict");
      }
    } else if (child.parent_scope_id !== null
      || (child.lifecycle !== "private" && child.lifecycle !== "shared")) {
      throw new ProjectMembershipTransitionError("conflict");
    }

    const nextRevision = Number(child.revision) + 1;
    const nextAuthEpoch = Number(child.auth_epoch) + 1;
    const updated = await trx.updateTable("collaboration_scopes").set({
      parent_scope_id: input.projectScopeId,
      membership_mode: "inherited",
      lifecycle: "shared",
      revision: nextRevision,
      auth_epoch: nextAuthEpoch,
      authority_runtime_id: input.destinationAuthorityRuntimeId,
      authority_generation: input.destinationAuthorityGeneration,
      updated_at: input.now,
    }).where("id", "=", child.id)
      .where("membership_mode", "=", child.membership_mode)
      .where("revision", "=", Number(child.revision))
      .where("auth_epoch", "=", Number(child.auth_epoch))
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new ProjectMembershipTransitionError("conflict");

    if (child.membership_mode === "direct") {
      const removed = await trx.deleteFrom("collaboration_members")
        .where("scope_id", "=", child.id)
        .returning("actor_id")
        .execute();
      if (removed.length !== members.length) {
        throw new ProjectMembershipTransitionError("conflict");
      }

      const recipients = members
        .filter((member) => member.actor_id !== input.ownerId
          && (member.status === "accepted" || member.status === "pending"))
        .map((member) => member.actor_id);
      if (recipients.length > 0) {
        await trx.insertInto("collaboration_directory_outbox").values({
          event_id: input.createEventId(),
          scope_id: child.id,
          recipient_actor_ids: recipients,
          authority_runtime_id: input.destinationAuthorityRuntimeId,
          authority_generation: input.destinationAuthorityGeneration,
          resource_kind: child.kind,
          discovery_state: "revoked",
          retry_after: input.now,
          attempts: 0,
          delivered_at: null,
          created_at: input.now,
        }).execute();
      }
      await trx.insertInto("collaboration_audit").values({
        scope_id: child.id,
        actor_id: input.requestedBy,
        action: "project.item_grants.reconciled",
        outcome: "completed",
        revision: nextRevision,
        reason_code: "project_inheritance",
        created_at: input.now,
      }).execute();
    }
  }
}
