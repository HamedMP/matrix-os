import {
  CollaborationOperationSchema,
  CollaborationScopeExportSchema,
  type CollaborationDiscussionMessage,
  type CollaborationOperation,
  type CollaborationScopeExport,
} from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import type { ChatLifecycleRepository } from "./chat-lifecycle-repository.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import {
  CollaborationRepositoryError,
  jsonb,
  lockDirectScope,
  MAX_SCOPE_PARTICIPANTS,
  OPERATION_RETENTION_MS,
  parseJson,
  readOperationReplay,
  requireAcceptedOwner,
  toIso,
  writeOperation,
} from "./repository-shared.js";
import type { TerminalExportInput } from "./repository-types.js";

/**
 * Extracted verbatim from packages/gateway/src/collaboration/repository.ts
 * (S01 / T008): terminal export and lifecycle operation reads. Chat lifecycle
 * stays in chat-lifecycle-repository.ts; transaction scopes are unchanged.
 */
export class CollaborationLifecycleRepository {
  constructor(
    private readonly db: Kysely<OwnerCollaborationDatabase>,
    private readonly chatLifecycle: ChatLifecycleRepository,
    private readonly options: { now: () => Date; maxExportBytes: number },
  ) {}

  private get now(): () => Date {
    return this.options.now;
  }

  private get maxExportBytes(): number {
    return this.options.maxExportBytes;
  }

  async applyTerminalExport(
    input: TerminalExportInput,
    prepareDiscussion: () => Promise<(
      trx: Transaction<OwnerCollaborationDatabase>,
    ) => Promise<CollaborationDiscussionMessage[]>>,
  ): Promise<CollaborationOperation> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const operationKind = "lifecycle.export";
    const existing = await this.db.selectFrom("collaboration_operations")
      .select(["payload_hash", "status", "result_ref"])
      .where("scope_id", "=", input.scopeId)
      .where("actor_id", "=", input.actorId)
      .where("client_request_id", "=", input.clientRequestId)
      .where("operation_kind", "=", operationKind)
      .executeTakeFirst();
    if (existing) {
      if (existing.payload_hash !== input.payloadHash
        || existing.status !== "completed" || existing.result_ref === null) {
        throw new CollaborationRepositoryError("conflict", "Operation key payload changed");
      }
      return CollaborationOperationSchema.parse(parseJson(existing.result_ref));
    }
    const loadDiscussion = await prepareDiscussion();
    return this.db.transaction().execute(async (trx) => {
      const replay = await readOperationReplay<CollaborationOperation>(trx, input, operationKind);
      if (replay) return CollaborationOperationSchema.parse(replay);
      const scope = await lockDirectScope(trx, input.scopeId);
      await requireAcceptedOwner(trx, input.scopeId, input.actorId);
      if (scope.kind !== "terminal" || scope.owner_id !== input.actorId) {
        throw new CollaborationRepositoryError("forbidden", "Owner terminal lifecycle access required");
      }
      if (scope.lifecycle !== "shared" || Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      const discussion = await loadDiscussion(trx);
      if (discussion.some((message) => message.scopeId !== scope.id)) {
        throw new CollaborationRepositoryError("conflict", "Terminal discussion scope changed");
      }
      await trx.insertInto("collaboration_audit").values({
        scope_id: scope.id,
        actor_id: input.actorId,
        action: "scope.exported",
        outcome: "completed",
        revision: Number(scope.revision),
        reason_code: null,
        created_at: now,
      }).execute();
      const [members, audit] = await Promise.all([
        trx.selectFrom("collaboration_members").selectAll().where("scope_id", "=", scope.id)
          .orderBy("updated_at", "asc").limit(MAX_SCOPE_PARTICIPANTS + 1).execute(),
        trx.selectFrom("collaboration_audit").selectAll().where("scope_id", "=", scope.id)
          .orderBy("created_at", "asc").orderBy("id", "asc").limit(10_001).execute(),
      ]);
      if (members.length > MAX_SCOPE_PARTICIPANTS || audit.length > 10_000) {
        throw new CollaborationRepositoryError("capacity", "Scope export exceeds safe limits");
      }
      const exportId = input.clientRequestId;
      const expiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
      const payload = CollaborationScopeExportSchema.parse({
        version: 1,
        id: exportId,
        scopeId: scope.id,
        exportedAt: now,
        expiresAt,
        scope: {
          kind: "terminal",
          resourceId: scope.resource_id,
          lifecycle: scope.lifecycle,
          revision: String(scope.revision),
        },
        members: members.map((member) => ({
          actorId: member.actor_id,
          role: member.role,
          status: member.status,
          revision: String(member.revision),
          ...(member.joined_at === null ? {} : { joinedAt: toIso(member.joined_at) }),
        })),
        audit: audit.map((record) => ({
          actorId: record.actor_id,
          action: record.action,
          outcome: record.outcome,
          revision: String(record.revision),
          ...(record.reason_code === null ? {} : { reasonCode: record.reason_code }),
          createdAt: toIso(record.created_at),
        })),
        discussion,
      });
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > this.maxExportBytes) {
        throw new CollaborationRepositoryError("capacity", "Scope export exceeds safe limits");
      }
      await trx.insertInto("collaboration_exports").values({
        id: exportId,
        scope_id: scope.id,
        owner_id: scope.owner_id,
        payload: jsonb(payload),
        created_at: now,
        expires_at: expiresAt,
      }).execute();
      const result = CollaborationOperationSchema.parse({
        id: input.clientRequestId,
        scopeId: scope.id,
        type: "export",
        status: "completed",
        revision: String(scope.revision),
        exportId,
        createdAt: now,
      });
      await writeOperation(
        trx,
        input,
        operationKind,
        scope,
        result,
        now,
        new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString(),
      );
      return result;
    });
  }

  async getLifecycleOperation(
    scopeId: string,
    actorId: string,
    operationId: string,
  ): Promise<CollaborationOperation | null> {
    return this.chatLifecycle.getOperation(scopeId, actorId, operationId);
  }

  async getScopeExport(
    scopeId: string,
    actorId: string,
    exportId: string,
  ): Promise<CollaborationScopeExport | null> {
    return this.chatLifecycle.getExport(scopeId, actorId, exportId);
  }
}
