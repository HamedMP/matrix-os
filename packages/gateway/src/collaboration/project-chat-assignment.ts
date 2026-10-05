import type { Kysely, Transaction } from "kysely";
import type { ChatOwner, ChatOutboxEvent, ChatRecord } from "../chat/records.js";
import type { ChatRepository } from "../chat/repository.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import { createProjectInheritanceResolver, ProjectInheritanceError } from "./project-inheritance.js";
import { appendMutationRecords, type ScopeRow } from "./repository-shared.js";

const MAX_BACKFILL_BATCH = 200;

type CollaborationTransaction = Transaction<OwnerCollaborationDatabase>;
type AssignmentRepository = Pick<ChatRepository, "create" | "update">;

export interface ProjectChatAssignmentCoordinator {
  run(
    owner: ChatOwner,
    operation: (repository: AssignmentRepository) => Promise<ChatRecord>,
  ): Promise<ChatRecord>;
  backfill(): Promise<number>;
}

interface ReconciliationEffects {
  chatEvents: ChatOutboxEvent[];
  endedScopeIds: string[];
}

interface BoundChat {
  bindingId: string;
  projectScopeId: string;
  scope: ScopeRow;
}

/**
 * Keeps a Chat's inherited scope in the same transaction as its project assignment.
 * Route publications use the durable directory outbox; live sessions for ended child
 * scopes are closed immediately after commit and later authorization fails against the
 * deleted owner scope.
 */
export function createProjectChatAssignmentCoordinator(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  chatRepository: ChatRepository;
  now?: () => Date;
  shouldContinue?: () => boolean;
  createBindingId?: () => string;
  createScopeId?: () => string;
  onScopeEnded?: (scopeId: string) => void;
}): ProjectChatAssignmentCoordinator {
  const now = options.now ?? (() => new Date());
  const shouldContinue = options.shouldContinue ?? (() => true);
  const inheritance = createProjectInheritanceResolver({
    db: options.db,
    now,
    ...(options.createBindingId ? { createBindingId: options.createBindingId } : {}),
    ...(options.createScopeId ? { createScopeId: options.createScopeId } : {}),
  });

  async function targetProject(
    trx: CollaborationTransaction,
    owner: ChatOwner,
    projectId: string | undefined,
  ) {
    if (!projectId) return null;
    return (await trx.selectFrom("collaboration_scopes").selectAll()
      .where("owner_type", "=", owner.type)
      .where("owner_id", "=", owner.ownerId)
      .where("kind", "=", "project")
      .where("resource_id", "=", projectId)
      .where("membership_mode", "=", "direct")
      .where("lifecycle", "=", "shared")
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst()) ?? null;
  }

  async function currentBinding(
    trx: CollaborationTransaction,
    owner: ChatOwner,
    chatId: string,
  ): Promise<BoundChat | null> {
    const rows = await trx.selectFrom("collaboration_resource_bindings as binding")
      .innerJoin("collaboration_scopes as child", "child.id", "binding.resource_scope_id")
      .select([
        "binding.id as binding_id",
        "binding.project_scope_id",
        "child.id",
        "child.owner_type",
        "child.owner_id",
        "child.organization_id",
        "child.kind",
        "child.resource_id",
        "child.parent_scope_id",
        "child.membership_mode",
        "child.lifecycle",
        "child.revision",
        "child.auth_epoch",
        "child.authority_runtime_id",
        "child.authority_generation",
        "child.execution_generation",
        "child.execution_eligibility",
        "child.created_at",
        "child.updated_at",
        "child.deleted_at",
      ])
      .where("binding.resource_kind", "=", "chat")
      .where("binding.resource_id", "=", chatId)
      .where("child.owner_type", "=", owner.type)
      .where("child.owner_id", "=", owner.ownerId)
      .where("child.kind", "=", "chat")
      .where("child.membership_mode", "=", "inherited")
      .where("child.lifecycle", "in", ["shared", "archived"])
      .where("child.deleted_at", "is", null)
      .orderBy("child.id", "asc")
      .limit(2)
      .forUpdate("child")
      .execute();
    if (rows.length > 1) throw new ProjectInheritanceError("conflict");
    const row = rows[0];
    if (!row) return null;
    const { binding_id: bindingId, project_scope_id: projectScopeId, ...scope } = row;
    return { bindingId, projectScopeId, scope };
  }

  async function endBinding(
    trx: CollaborationTransaction,
    binding: BoundChat,
    at: Date,
  ): Promise<string> {
    await trx.updateTable("chat_queued_turns").set({
      status: "cancelled",
      cancelled_at: at,
      updated_at: at,
    }).where("chat_id", "=", binding.scope.resource_id)
      .where("collaboration_scope_id", "=", binding.scope.id)
      .where("status", "=", "queued")
      .execute();
    const ended = await trx.updateTable("collaboration_scopes").set({
      lifecycle: "deleted",
      revision: Number(binding.scope.revision) + 1,
      auth_epoch: Number(binding.scope.auth_epoch) + 1,
      updated_at: at,
      deleted_at: at,
    }).where("id", "=", binding.scope.id)
      .where("membership_mode", "=", "inherited")
      .where("revision", "=", Number(binding.scope.revision))
      .where("deleted_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (!ended) throw new ProjectInheritanceError("conflict");
    const removed = await trx.deleteFrom("collaboration_resource_bindings")
      .where("id", "=", binding.bindingId)
      .where("project_scope_id", "=", binding.projectScopeId)
      .returning("id")
      .executeTakeFirst();
    if (!removed) throw new ProjectInheritanceError("conflict");
    await appendMutationRecords(trx, {
      scope: ended,
      actorId: ended.owner_id,
      action: "scope.deleted",
      recipients: [],
      discoveryState: "deleted",
      // Project-Chat directory rows have no child recipients and the current
      // directory contract has no route-delete operation. The deleted owner
      // scope fails every future exchange; publishing an ordinary child event
      // without its route parent would instead retry as a platform conflict.
      publishDirectory: false,
      now: at.toISOString(),
      reasonCode: "project_chat_moved",
    });
    return ended.id;
  }

  async function reconcile(
    trx: CollaborationTransaction,
    owner: ChatOwner,
    record: ChatRecord,
  ): Promise<ReconciliationEffects> {
    const effects: ReconciliationEffects = { chatEvents: [], endedScopeIds: [] };
    const target = await targetProject(trx, owner, record.projectId);
    const current = await currentBinding(trx, owner, record.chat.id);
    if (current && current.projectScopeId !== target?.id) {
      effects.endedScopeIds.push(await endBinding(trx, current, now()));
    }
    if (target && current?.projectScopeId !== target.id) {
      const result = await inheritance.bindOwnedResourceInTransaction(trx, {
        projectScopeId: target.id,
        ownerId: owner.ownerId,
        kind: "chat",
        resourceId: record.chat.id,
        authorityRuntimeId: target.authority_runtime_id,
        authorityGeneration: Number(target.authority_generation),
        revision: record.chat.revision,
        readiness: "ready",
      });
      if (result.chatEvent) effects.chatEvents.push(result.chatEvent);
    }
    return effects;
  }

  function publishEffects(owner: ChatOwner, effects: ReconciliationEffects): void {
    for (const event of effects.chatEvents) {
      options.chatRepository.publishCommittedExternalOutbox(owner, event);
    }
    for (const scopeId of effects.endedScopeIds) {
      try {
        options.onScopeEnded?.(scopeId);
      } catch (error: unknown) {
        console.warn("[collaboration-project] Chat scope session revocation failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
  }

  async function run(
    owner: ChatOwner,
    operation: (repository: AssignmentRepository) => Promise<ChatRecord>,
  ): Promise<ChatRecord> {
    try {
      let effects: ReconciliationEffects = { chatEvents: [], endedScopeIds: [] };
      const result = await options.chatRepository.withTransaction(async (repository) => {
        const record = await operation(repository);
        effects = await reconcile(
          repository.kysely as unknown as CollaborationTransaction,
          owner,
          record,
        );
        if (effects.chatEvents.some((event) => event.chatId === record.chat.id)) {
          const refreshed = await repository.get(owner, record.chat.id);
          if (!refreshed) throw new ProjectInheritanceError("conflict");
          return refreshed;
        }
        return record;
      });
      publishEffects(owner, effects);
      return result;
    } catch (error: unknown) {
      if (error instanceof ProjectInheritanceError) throw error;
      console.warn("[collaboration-project] Chat project assignment failed", error instanceof Error ? error.name : "UnknownError");
      throw new ProjectInheritanceError("unavailable");
    }
  }

  async function backfill(): Promise<number> {
    let reconciled = 0;
    while (shouldContinue()) {
      let batchEffects: Array<{ owner: ChatOwner; effects: ReconciliationEffects }> = [];
      const selected = await options.db.transaction().execute(async (trx) => {
        const rows = await trx.selectFrom("chats as chat")
          .innerJoin("collaboration_scopes as project", (join) => join
            .onRef("project.owner_type", "=", "chat.owner_type")
            .onRef("project.owner_id", "=", "chat.owner_id")
            .onRef("project.resource_id", "=", "chat.project_id")
            .on("project.kind", "=", "project")
            .on("project.membership_mode", "=", "direct")
            .on("project.lifecycle", "=", "shared")
            .on("project.deleted_at", "is", null))
          .leftJoin("collaboration_resource_bindings as binding", (join) => join
            .onRef("binding.project_scope_id", "=", "project.id")
            .on("binding.resource_kind", "=", "chat")
            .onRef("binding.resource_id", "=", "chat.id"))
          .select(["chat.id", "chat.owner_type", "chat.owner_id", "chat.project_id", "chat.revision"])
          .where("binding.id", "is", null)
          .orderBy("chat.id", "asc")
          .limit(MAX_BACKFILL_BATCH)
          .forUpdate("chat")
          .execute();
        for (const row of rows) {
          const owner: ChatOwner = { type: row.owner_type, ownerId: row.owner_id };
          const effects = await reconcile(trx, owner, {
            chat: {
              id: row.id,
              ownerScope: owner,
              title: "Backfill",
              lifecycle: "active",
              attention: "none",
              revision: Number(row.revision),
              messageCount: 0,
              createdAt: now().toISOString(),
              updatedAt: now().toISOString(),
            },
            ...(row.project_id ? { projectId: row.project_id } : {}),
          });
          batchEffects.push({ owner, effects });
        }
        return rows.length;
      });
      for (const item of batchEffects) publishEffects(item.owner, item.effects);
      reconciled += selected;
      if (selected < MAX_BACKFILL_BATCH) return reconciled;
    }
    return reconciled;
  }

  return { run, backfill };
}
