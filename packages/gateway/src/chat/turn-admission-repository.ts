import {
  CanonicalChatIdSchema, CanonicalChatMessageSchema, CanonicalChatRunSchema,
  CanonicalChatTurnSchema, CanonicalOwnerScopeSchema,
  type CanonicalChatMessage, type CanonicalChatTurn,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { ChatDatabase, ChatRunsTable, ChatsTable } from "./database.js";
import { ChatBusyError, ChatConflictError, ChatNotFoundError, ChatProviderInstanceLockedError } from "./errors.js";
import { jsonb, messageAttribution, messageSearchText, toTurn, type ChatOwner, type ChatRecord, type ChatOutboxEventType } from "./records.js";
import type { AdmitTurnInput, AdmittedTurn } from "./repository.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
const encoded = new TextEncoder();
export interface TurnAdmissionDependencies {
  transact<T>(operation: (trx: Executor) => Promise<T>): Promise<T>;
  appendOutbox(executor: Executor, owner: ChatOwner, chatId: string, revision: number, eventType: ChatOutboxEventType, payload?: Record<string, unknown>): Promise<void>;
  selectOwnedChat(executor: Executor, owner: ChatOwner, chatId: string, lock?: boolean): Promise<Selectable<ChatsTable> | undefined>;
  hydrateAdmission(executor: Executor, owner: ChatOwner, turn: CanonicalChatTurn): Promise<AdmittedTurn>;
  toPrincipalRecord(executor: Executor, owner: ChatOwner, row: Selectable<ChatsTable>): Promise<ChatRecord>;
  activeRunQuery(executor: Executor, chatId: string): Promise<Selectable<ChatRunsTable> | undefined>;
  postgresUniqueConstraint(error: unknown): string | null;
  preview(message: CanonicalChatMessage): string | null;
}

/** The Chat row lock, related writes and outbox share one transaction. */
export async function admitChatTurn(deps: TurnAdmissionDependencies, ownerInput: ChatOwner, input: AdmitTurnInput): Promise<AdmittedTurn> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    CanonicalChatIdSchema.parse(input.chatId);
    const message = CanonicalChatMessageSchema.parse(input.message);
    const turn = CanonicalChatTurnSchema.parse(input.turn);
    const run = CanonicalChatRunSchema.parse(input.run);
    if (message.chatId !== input.chatId || turn.chatId !== input.chatId || run.chatId !== input.chatId
      || turn.inputMessageId !== message.id || message.turnId !== turn.id || message.runId !== undefined
      || message.role !== "user" || message.state !== "committed" || run.turnId !== turn.id) {
      throw new ChatConflictError(input.chatId, input.baseRevision);
    }
    if (turn.status !== "accepted" || run.status !== "accepted") throw new ChatConflictError(input.chatId, input.baseRevision);
    const stateBytes = input.adapterState ? encoded.encode(JSON.stringify(input.adapterState.state)).byteLength : 0;
    if (input.adapterState && (!Number.isInteger(input.adapterState.schemaVersion)
      || input.adapterState.schemaVersion < 1 || stateBytes > 64 * 1024)) {
      throw new ChatConflictError(input.chatId, input.baseRevision);
    }

    return deps.transact(async (trx) => {
      const current = await deps.selectOwnedChat(trx, owner, input.chatId, true);
      if (!current) throw new ChatNotFoundError(input.chatId);
      const duplicate = await trx.selectFrom("chat_turns").selectAll()
        .where("chat_id", "=", input.chatId)
        .where("client_request_id", "=", turn.clientRequestId)
        .executeTakeFirst();
      if (duplicate) {
        const accepted = await deps.hydrateAdmission(trx, owner, toTurn(duplicate));
        if (accepted.run.context?.requestHash !== run.context?.requestHash) {
          throw new ChatConflictError(input.chatId, Number(current.revision));
        }
        return accepted;
      }
      if (current.lifecycle !== "active") {
        throw new ChatConflictError(input.chatId, Number(current.revision));
      }
      if (current.collaboration !== null) {
        throw new ChatConflictError(input.chatId, Number(current.revision));
      }
      if (Number(current.revision) !== input.baseRevision) {
        throw new ChatConflictError(input.chatId, Number(current.revision));
      }
      if (await deps.activeRunQuery(trx, input.chatId)) throw new ChatBusyError(input.chatId);
      if (!run.context?.agent && current.bound_instance_id && (current.bound_instance_id !== run.instanceId
        || current.bound_driver_kind !== run.driverKind)) {
        throw new ChatProviderInstanceLockedError(input.chatId);
      }
      const latest = await trx.selectFrom("chat_messages")
        .select(({ fn }) => fn.max("seq").as("seq"))
        .where("chat_id", "=", input.chatId).executeTakeFirst();
      const lastSeq = Number(latest?.seq ?? 0);
      if (message.seq !== lastSeq + 1 || turn.baseMessageSeq !== lastSeq) {
        throw new ChatConflictError(input.chatId, Number(current.revision));
      }

      await trx.insertInto("chat_messages").values({
        id: message.id,
        chat_id: input.chatId,
        seq: message.seq,
        role: message.role,
        state: message.state,
        turn_id: message.turnId ?? null,
        run_id: message.runId ?? null,
        parts: jsonb(message.parts),
        byte_count: encoded.encode(JSON.stringify(message)).byteLength,
        search_text: messageSearchText(message),
        ...messageAttribution(message),
        created_at: message.createdAt,
      }).execute();
      for (const part of message.parts) {
        if (part.type !== "attachment_reference") continue;
        await trx.insertInto("chat_attachments").values({
          id: part.attachmentId,
          chat_id: input.chatId,
          message_id: message.id,
          kind: part.kind,
          label: part.label,
          mime_type: part.mimeType ?? null,
          size_bytes: part.sizeBytes ?? null,
          owner_reference: part.ownerReference ?? null,
        }).execute();
      }
      await trx.insertInto("chat_turns").values({
        id: turn.id,
        chat_id: input.chatId,
        client_request_id: turn.clientRequestId,
        base_message_seq: turn.baseMessageSeq,
        input_message_id: turn.inputMessageId,
        status: turn.status,
        created_at: turn.createdAt,
        updated_at: turn.updatedAt,
      }).execute();
      await trx.insertInto("chat_runs").values({
        id: run.id,
        chat_id: input.chatId,
        turn_id: run.turnId,
        client_request_id: turn.clientRequestId,
        attempt: run.attempt,
        driver_kind: run.driverKind,
        instance_id: run.instanceId,
        selection: jsonb(run.selection),
        interaction_mode: run.interactionMode,
        permission_mode: run.permissionMode,
        execution_root: run.executionRoot ? jsonb(run.executionRoot) : null,
        execution_root_fingerprint: run.executionRootFingerprint ?? null,
        status: run.status,
        outcome: run.outcome ?? null,
        started_at: run.startedAt ?? null,
        completed_at: run.completedAt ?? null,
        history_boundary_seq: run.historyBoundarySeq,
        context_snapshot: run.context ? jsonb(run.context) : null,
        capability_snapshot: jsonb(run.capabilitySnapshot),
        created_at: run.createdAt,
        updated_at: run.updatedAt,
      }).execute();
      if (input.adapterState) {
        await trx.insertInto("chat_run_adapter_state").values({
          run_id: run.id,
          driver_kind: run.driverKind,
          instance_id: run.instanceId,
          schema_version: input.adapterState.schemaVersion,
          state: jsonb(input.adapterState.state),
          byte_count: stateBytes,
        }).execute();
      }

      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({
        revision,
        message_count: sql<number>`message_count + 1`,
        last_message_preview: deps.preview(message),
        ...(!run.context?.agent ? {
          current_selection: jsonb(run.selection),
          bound_driver_kind: current.bound_driver_kind ?? run.driverKind,
          bound_instance_id: current.bound_instance_id ?? run.instanceId,
          bound_at_turn_id: current.bound_at_turn_id ?? turn.id,
        } : {}),
        updated_at: sql`now()`,
      }).where("id", "=", input.chatId).where("revision", "=", input.baseRevision)
        .returningAll().executeTakeFirst();
      if (!updated) throw new ChatConflictError(input.chatId, Number(current.revision));
      await deps.appendOutbox(trx, owner, input.chatId, revision, "turn.accepted", { runId: run.id, turnId: turn.id });
      return {
        chat: await deps.toPrincipalRecord(trx, owner, updated),
        message,
        turn,
        run,
        alreadyAccepted: false,
      };
    }).catch((error: unknown) => {
      if (error instanceof ChatNotFoundError || error instanceof ChatConflictError
        || error instanceof ChatBusyError || error instanceof ChatProviderInstanceLockedError) throw error;
      const constraint = deps.postgresUniqueConstraint(error);
      if (constraint === "idx_chat_runs_one_active") throw new ChatBusyError(input.chatId);
      if (constraint !== null) throw new ChatConflictError(input.chatId, input.baseRevision);
      throw error;
    });
  }
