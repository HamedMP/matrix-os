import {
  CanonicalChatActiveRunProjectionSchema,
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatRunSchema,
  CanonicalChatSchema,
  CanonicalChatTurnSchema,
  CanonicalChatProviderBindingSchema,
  type CanonicalChat,
  type CanonicalChatMessage,
  type CanonicalChatProviderBinding,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
  type CanonicalChatSummary,
  type CanonicalChatTurn,
  type CanonicalChatUserState,
  type CanonicalOwnerScope,
} from "@matrix-os/contracts";
import { sql, type RawBuilder, type Selectable } from "kysely";
import type {
  ChatLegacyImportsTable,
  ChatMigrationsTable,
  ChatMessagesTable,
  ChatOutboxTable,
  ChatRunEventsTable,
  ChatRunsTable,
  ChatTurnsTable,
  ChatsTable,
} from "./database.js";

export type ChatOwner = CanonicalOwnerScope;

export interface ChatRecord {
  chat: CanonicalChat;
  projectId?: string;
  providerBinding?: CanonicalChatProviderBinding;
  activeRun?: NonNullable<CanonicalChatSummary["activeRun"]>;
}

export type ChatOutboxEventType =
  | "chat.created"
  | "chat.updated"
  | "chat.user_state_updated"
  | "turn.accepted"
  | "run.activity"
  | "chat.terminal_bound"
  | "run.completed"
  | "run.failed"
  | "run.aborted"
  | "chat.deleted"
  | "migration.completed";

export interface ChatOutboxEvent {
  cursor: number;
  chatId: string;
  revision: number;
  eventType: ChatOutboxEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ChatLegacyImportRecord {
  sourceKind: string;
  sourceId: string;
  chatId: string;
  sourceHash: string;
  importVersion: number;
  verificationStatus: "pending" | "verified" | "failed";
  updatedAt: string;
}

export interface ChatMigrationRecord {
  migrationId: string;
  phase: string;
  sourceFingerprint: string;
  importedCount: number;
  errorCount: number;
  cutoverAt?: string;
  legacyAliasExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatExport {
  chat: ChatRecord;
  messages: CanonicalChatMessage[];
  turns: CanonicalChatTurn[];
  runs: CanonicalChatRun[];
  activities: CanonicalChatRunActivity[];
  attachments: Array<{
    id: string;
    messageId: string;
    kind: "file" | "image" | "diff" | "structured_ref";
    label: string;
    mimeType?: string;
    sizeBytes?: number;
  }>;
}

export function asIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export function jsonb(value: unknown): RawBuilder<unknown> {
  return sql`${JSON.stringify(value)}::jsonb`;
}

export function messageSearchText(message: CanonicalChatMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" || part.type === "summary") return [part.text];
      if (part.type === "status") return [part.label, part.detail ?? ""];
      return [];
    })
    .join("\n")
    .slice(0, 96 * 1024);
}

export function toChatRecord(
  row: Selectable<ChatsTable>,
  activeRun?: Selectable<ChatRunsTable>,
  userState?: CanonicalChatUserState,
): ChatRecord {
  const chat = CanonicalChatSchema.parse({
    id: row.id,
    ownerScope: { type: row.owner_type, ownerId: row.owner_id },
    title: row.title,
    lifecycle: row.lifecycle,
    attention: row.attention,
    revision: Number(row.revision),
    messageCount: Number(row.message_count),
    ...(row.collaboration === null ? {} : { collaboration: parseJson(row.collaboration) }),
    userState: userState
      ?? (row.user_state === null
        ? { readThroughSeq: 0, pinned: false, muted: false }
        : parseJson(row.user_state)),
    ...(row.shell_state === null ? {} : { shellState: parseJson(row.shell_state) }),
    ...(row.fork_provenance === null ? {} : { forkProvenance: parseJson(row.fork_provenance) }),
    ...(row.last_message_preview === null ? {} : { lastMessagePreview: row.last_message_preview }),
    ...(row.current_selection === null ? {} : { currentSelection: parseJson(row.current_selection) }),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
  const providerBinding = row.bound_driver_kind && row.bound_instance_id && row.bound_at_turn_id
    ? CanonicalChatProviderBindingSchema.parse({
        driverKind: row.bound_driver_kind,
        instanceId: row.bound_instance_id,
        lockedAtTurnId: row.bound_at_turn_id,
      })
    : undefined;
  return {
    chat,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(providerBinding ? { providerBinding } : {}),
    ...(activeRun ? {
      activeRun: CanonicalChatActiveRunProjectionSchema.parse({
        runId: activeRun.id,
        turnId: activeRun.turn_id,
        status: activeRun.status,
      }),
    } : {}),
  };
}

export function toMessage(row: Selectable<ChatMessagesTable>): CanonicalChatMessage {
  return CanonicalChatMessageSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    seq: Number(row.seq),
    role: row.role,
    state: row.state,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    parts: parseJson(row.parts),
    createdAt: asIso(row.created_at),
  });
}

export function toTurn(row: Selectable<ChatTurnsTable>): CanonicalChatTurn {
  return CanonicalChatTurnSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    clientRequestId: row.client_request_id,
    baseMessageSeq: Number(row.base_message_seq),
    inputMessageId: row.input_message_id,
    status: row.status,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

export function toRun(row: Selectable<ChatRunsTable>): CanonicalChatRun {
  return CanonicalChatRunSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    turnId: row.turn_id,
    attempt: row.attempt,
    driverKind: row.driver_kind,
    instanceId: row.instance_id,
    selection: parseJson(row.selection),
    interactionMode: row.interaction_mode,
    permissionMode: row.permission_mode,
    ...(row.execution_root === null ? {} : { executionRoot: parseJson(row.execution_root) }),
    ...(row.execution_root_fingerprint === null
      ? {}
      : { executionRootFingerprint: row.execution_root_fingerprint }),
    status: row.status,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.started_at === null ? {} : { startedAt: asIso(row.started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: asIso(row.completed_at) }),
    historyBoundarySeq: Number(row.history_boundary_seq),
    capabilitySnapshot: parseJson(row.capability_snapshot),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

export function toActivity(row: Selectable<ChatRunEventsTable>): CanonicalChatRunActivity | null {
  const event = parseJson<unknown>(row.event);
  const parsed = CanonicalChatRunActivitySchema.safeParse(event);
  if (parsed.success) return parsed.data;
  if (
    typeof event === "object"
    && event !== null
    && "type" in event
    && event.type === "terminal.bound"
    && !("terminalSessionCreatedAt" in event)
  ) {
    return null;
  }
  return CanonicalChatRunActivitySchema.parse(event);
}

export function toActivities(
  rows: readonly Selectable<ChatRunEventsTable>[],
): CanonicalChatRunActivity[] {
  return rows.flatMap((row) => {
    const activity = toActivity(row);
    return activity ? [activity] : [];
  });
}

export function toOutbox(row: Selectable<ChatOutboxTable>): ChatOutboxEvent {
  return {
    cursor: Number(row.cursor),
    chatId: row.chat_id,
    revision: Number(row.revision),
    eventType: row.event_type as ChatOutboxEventType,
    payload: parseJson<Record<string, unknown>>(row.payload),
    createdAt: asIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export function toLegacyImport(row: Selectable<ChatLegacyImportsTable>): ChatLegacyImportRecord {
  return {
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    chatId: row.chat_id,
    sourceHash: row.source_hash,
    importVersion: row.import_version,
    verificationStatus: row.verification_status,
    updatedAt: asIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function toMigration(row: Selectable<ChatMigrationsTable>): ChatMigrationRecord {
  return {
    migrationId: row.migration_id,
    phase: row.phase,
    sourceFingerprint: row.source_fingerprint,
    importedCount: row.imported_count,
    errorCount: row.error_count,
    ...(row.cutover_at === null ? {} : { cutoverAt: asIso(row.cutover_at) }),
    ...(row.legacy_alias_expires_at === null ? {} : { legacyAliasExpiresAt: asIso(row.legacy_alias_expires_at) }),
    createdAt: asIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: asIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}
