import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type ColumnType, type Dialect, type Selectable, type Transaction } from "kysely";
import pg from "pg";
import { getMessagingBridgeAccountProvider, MESSAGING_NETWORKS } from "./bridge-accounts.js";
import { isSetupExpired } from "./setup-sessions.js";
import type {
  AccountSetupRequest,
  CompleteSetupRequest,
  ConversationMapping,
  BridgeEventEffect,
  DisconnectAccountRequest,
  HermesPermission,
  HermesWorkItem,
  HermesWorkItemKind,
  HermesWorkItemStatus,
  MatrixConversation,
  MessagingAccount,
  MessagingNetwork,
  MessagingNetworkSlug,
  OutgoingReply,
  OutgoingReplySource,
  OutgoingReplyStatus,
  SetupSession,
} from "./schemas.js";
import { MessagingError } from "./errors.js";
import { sanitizeAuditSummary, type MessagingAuditInput } from "./audit.js";

export interface MessagingOwnerScope {
  ownerId: string;
}

export interface MessagingListOptions {
  limit?: number;
  cursor?: string;
}

export interface MessagingListResult<T> {
  items: T[];
  nextCursor?: string;
}

export interface CreateSetupSessionInput extends AccountSetupRequest {
  ownerId: string;
}

export interface CompleteSetupSessionInput extends CompleteSetupRequest {
  ownerId: string;
  setupId: string;
}

export interface DisconnectAccountInput extends DisconnectAccountRequest {
  ownerId: string;
  accountId: string;
}

export interface UpsertConversationInput {
  ownerId: string;
  roomId: string;
  networkSlug: MessagingNetworkSlug;
  accountId: string;
  displayName: string;
  avatarUrl?: string;
  lastEventAt?: string;
}

export interface UpsertConversationMappingInput {
  ownerId: string;
  networkSlug: MessagingNetworkSlug;
  accountId: string;
  roomId: string;
  externalThreadId: string;
  authoritative: boolean;
}

export interface UpdatePermissionInput {
  ownerId: string;
  roomId: string;
  baseRevision: number;
  readEnabled: boolean;
  replyEnabled: boolean;
  automationEnabled: boolean;
  mentionOnly: boolean;
  grantedBy: string;
}

export interface IngestBridgeEventInput {
  ownerId: string;
  networkSlug: MessagingNetworkSlug;
  accountId: string;
  roomId: string;
  eventId: string;
  externalEventId?: string;
  content: { kind: "text"; body: string; mentionsOwner?: boolean };
  occurredAt: string;
}

export interface IngestBridgeEventResult {
  accepted: boolean;
  effect: BridgeEventEffect;
}

export interface CreateReplyInput {
  ownerId: string;
  roomId: string;
  source: OutgoingReplySource;
  status: OutgoingReplyStatus;
  body: string;
  permissionRevision: number;
  clientTxnId: string;
}

export interface CreateReplyAfterPermissionCheckInput {
  ownerId: string;
  roomId: string;
  source: OutgoingReplySource;
  body: string;
  mode: "send_if_allowed" | "draft_if_not_allowed" | "approval_required";
  clientTxnId: string;
}

export interface ApproveReplyInput {
  ownerId: string;
  replyId: string;
  baseStatus: "approval_required";
}

export interface CancelReplyInput {
  ownerId: string;
  replyId: string;
  reason: "user_cancelled" | "permission_revoked";
}

export interface ReplySendResult {
  replyId: string;
  status: OutgoingReplyStatus;
  matrixEventId?: string;
}

export interface EnqueueHermesWorkInput {
  ownerId: string;
  roomId: string;
  sourceEventId: string;
  kind: HermesWorkItemKind;
  status?: HermesWorkItemStatus;
  permissionRevision: number;
}

export interface MessagingRepository {
  listNetworks(): Promise<MessagingNetwork[]>;
  listAccounts(scope: MessagingOwnerScope): Promise<MessagingAccount[]>;
  getAccount(scope: MessagingOwnerScope, accountId: string): Promise<MessagingAccount | null>;
  createSetupSession(input: CreateSetupSessionInput): Promise<SetupSession>;
  completeSetupSession(input: CompleteSetupSessionInput): Promise<MessagingAccount>;
  disconnectAccount(input: DisconnectAccountInput): Promise<MessagingAccount>;
  listConversations(
    scope: MessagingOwnerScope,
    options?: MessagingListOptions,
  ): Promise<MessagingListResult<MatrixConversation>>;
  getMappingByExternalThread(input: {
    ownerId: string;
    networkSlug: MessagingNetworkSlug;
    accountId: string;
    externalThreadId: string;
  }): Promise<ConversationMapping | null>;
  upsertConversation(input: UpsertConversationInput): Promise<MatrixConversation>;
  upsertConversationMapping(input: UpsertConversationMappingInput): Promise<ConversationMapping>;
  getPermission(scope: MessagingOwnerScope, roomId: string): Promise<HermesPermission | null>;
  getPermissions(scope: MessagingOwnerScope, roomIds: string[]): Promise<Record<string, HermesPermission>>;
  updatePermission(input: UpdatePermissionInput): Promise<HermesPermission>;
  ingestBridgeEvent(input: IngestBridgeEventInput): Promise<IngestBridgeEventResult>;
  createReply(input: CreateReplyInput): Promise<OutgoingReply>;
  createReplyAfterPermissionCheck(input: CreateReplyAfterPermissionCheckInput): Promise<ReplySendResult>;
  markReplySending(input: { ownerId: string; replyId: string }): Promise<OutgoingReply>;
  markReplySent(input: { ownerId: string; replyId: string; matrixEventId: string }): Promise<OutgoingReply>;
  markReplyFailed(input: { ownerId: string; replyId: string; failureCode: NonNullable<OutgoingReply["failureCode"]> }): Promise<OutgoingReply>;
  listDrafts(scope: MessagingOwnerScope, options?: MessagingListOptions & { roomId?: string }): Promise<MessagingListResult<OutgoingReply>>;
  getReply(input: { ownerId: string; replyId: string }): Promise<OutgoingReply | null>;
  approveReply(input: ApproveReplyInput): Promise<ReplySendResult>;
  cancelReply(input: CancelReplyInput): Promise<ReplySendResult>;
  enqueueHermesWork(input: EnqueueHermesWorkInput): Promise<HermesWorkItem>;
  listWorkItems(scope: MessagingOwnerScope & { roomId?: string }): Promise<HermesWorkItem[]>;
}

export interface BridgeAccountSetupState {
  setupUrl?: string;
  qrCode?: string;
  pairingCode?: string;
  expiresAt: string;
}

export interface MessagingBridgeAccountProvider {
  beginSetup(input: { ownerId: string; networkSlug: MessagingNetworkSlug; setupId: string }): Promise<BridgeAccountSetupState>;
  disconnect(input: { ownerId: string; networkSlug: MessagingNetworkSlug; accountId: string }): Promise<void>;
}

export interface MessagingAccountsTable {
  id: string;
  owner_id: string;
  network_slug: MessagingNetworkSlug;
  external_account_id: string | null;
  display_name: string | null;
  status: MessagingAccount["status"];
  status_reason: string | null;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingSetupSessionsTable {
  id: string;
  owner_id: string;
  network_slug: MessagingNetworkSlug;
  account_id: string | null;
  status: SetupSession["status"];
  setup_url: string | null;
  qr_code: string | null;
  pairing_code: string | null;
  expires_at: ColumnType<Date | string, Date | string, Date | string>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingConversationsTable {
  id: string;
  owner_id: string;
  room_id: string;
  network_slug: MessagingNetworkSlug;
  account_id: string;
  display_name: string;
  avatar_url: string | null;
  last_event_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingConversationMappingsTable {
  id: string;
  owner_id: string;
  network_slug: MessagingNetworkSlug;
  account_id: string;
  room_id: string;
  external_thread_id: string;
  authoritative: boolean;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingPermissionsTable {
  owner_id: string;
  room_id: string;
  read_enabled: boolean;
  reply_enabled: boolean;
  automation_enabled: boolean;
  mention_only: boolean;
  revoked_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  revision: number;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingAuditEventsTable {
  id: string;
  owner_id: string;
  type: string;
  network_slug: MessagingNetworkSlug | null;
  room_id: string | null;
  account_id: string | null;
  actor: string;
  safe_summary: string;
  metadata: ColumnType<unknown, unknown | undefined, unknown>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingEventCursorsTable {
  owner_id: string;
  network_slug: MessagingNetworkSlug;
  room_id: string | null;
  event_id: string;
  external_event_id: string | null;
  event_hash: string | null;
  processed_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  effect: BridgeEventEffect;
}

export interface MessagingOutgoingRepliesTable {
  id: string;
  owner_id: string;
  room_id: string;
  source: OutgoingReplySource;
  status: OutgoingReplyStatus;
  body: string;
  permission_revision: number;
  client_txn_id: string;
  matrix_event_id: string | null;
  failure_code: OutgoingReply["failureCode"] | null;
  cancel_reason: OutgoingReply["cancelReason"] | null;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingHermesWorkItemsTable {
  id: string;
  owner_id: string;
  room_id: string;
  source_event_id: string;
  kind: HermesWorkItemKind;
  status: HermesWorkItemStatus;
  permission_revision: number;
  abort_token_id: string;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface MessagingDatabase {
  messaging_accounts: MessagingAccountsTable;
  messaging_setup_sessions: MessagingSetupSessionsTable;
  messaging_conversations: MessagingConversationsTable;
  messaging_conversation_mappings: MessagingConversationMappingsTable;
  messaging_permissions: MessagingPermissionsTable;
  messaging_audit_events: MessagingAuditEventsTable;
  messaging_event_cursors: MessagingEventCursorsTable;
  messaging_outgoing_replies: MessagingOutgoingRepliesTable;
  messaging_hermes_work_items: MessagingHermesWorkItemsTable;
}

function prefixedId(prefix: "acct" | "setup" | "conv" | "map" | "reply" | "work" | "audit" | "abort"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireIso(value: Date | string): string {
  return iso(value) ?? new Date().toISOString();
}

function toAccount(row: Selectable<MessagingAccountsTable>): MessagingAccount {
  return {
    id: row.id,
    ownerId: row.owner_id,
    networkSlug: row.network_slug,
    externalAccountId: row.external_account_id ?? undefined,
    displayName: row.display_name ?? undefined,
    status: row.status,
    statusReason: row.status_reason ?? undefined,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

function toSetupSession(row: Selectable<MessagingSetupSessionsTable>): SetupSession {
  return {
    id: row.id,
    ownerId: row.owner_id,
    networkSlug: row.network_slug,
    accountId: row.account_id ?? undefined,
    status: row.status,
    setupUrl: row.setup_url ?? undefined,
    qrCode: row.qr_code ?? undefined,
    pairingCode: row.pairing_code ?? undefined,
    expiresAt: requireIso(row.expires_at),
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

function toConversation(row: Selectable<MessagingConversationsTable>): MatrixConversation {
  return {
    id: row.id,
    ownerId: row.owner_id,
    roomId: row.room_id,
    networkSlug: row.network_slug,
    accountId: row.account_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? undefined,
    lastEventAt: iso(row.last_event_at),
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

function toMapping(row: Selectable<MessagingConversationMappingsTable>): ConversationMapping {
  return {
    id: row.id,
    ownerId: row.owner_id,
    networkSlug: row.network_slug,
    accountId: row.account_id,
    roomId: row.room_id,
    externalThreadId: row.external_thread_id,
    authoritative: row.authoritative,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

function toPermission(row: Selectable<MessagingPermissionsTable>): HermesPermission {
  return {
    ownerId: row.owner_id,
    roomId: row.room_id,
    readEnabled: row.read_enabled,
    replyEnabled: row.reply_enabled,
    automationEnabled: row.automation_enabled,
    mentionOnly: row.mention_only,
    revokedAt: iso(row.revoked_at),
    revision: Number(row.revision),
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

function toReply(row: Selectable<MessagingOutgoingRepliesTable>): OutgoingReply {
  return {
    id: row.id,
    ownerId: row.owner_id,
    roomId: row.room_id,
    source: row.source,
    status: row.status,
    body: row.body,
    permissionRevision: Number(row.permission_revision),
    clientTxnId: row.client_txn_id,
    matrixEventId: row.matrix_event_id ?? undefined,
    failureCode: row.failure_code ?? undefined,
    cancelReason: row.cancel_reason ?? undefined,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

function toWorkItem(row: Selectable<MessagingHermesWorkItemsTable>): HermesWorkItem {
  return {
    id: row.id,
    ownerId: row.owner_id,
    roomId: row.room_id,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    status: row.status,
    permissionRevision: Number(row.permission_revision),
    abortTokenId: row.abort_token_id,
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

export class MessagingKyselyRepository implements MessagingRepository {
  readonly kysely: Kysely<MessagingDatabase>;
  private readonly ownsConnection: boolean;
  private readonly providers: Partial<Record<MessagingNetworkSlug, MessagingBridgeAccountProvider>>;

  constructor(
    dialectOrKysely: Dialect | Kysely<MessagingDatabase>,
    providers: Partial<Record<MessagingNetworkSlug, MessagingBridgeAccountProvider>> = {},
  ) {
    if (dialectOrKysely instanceof Kysely) {
      this.kysely = dialectOrKysely;
      this.ownsConnection = false;
    } else {
      this.kysely = new Kysely<MessagingDatabase>({ dialect: dialectOrKysely });
      this.ownsConnection = true;
    }
    this.providers = providers;
  }

  static fromConnectionString(connectionString: string): MessagingKyselyRepository {
    const pool = new pg.Pool({ connectionString, max: 10 });
    pool.on("error", (err) => {
      console.error("[messages/repository] Idle pool client error:", err.message);
    });
    return new MessagingKyselyRepository(new PostgresDialect({ pool }));
  }

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS messaging_accounts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        network_slug TEXT NOT NULL CHECK (network_slug IN ('telegram', 'whatsapp')),
        external_account_id TEXT,
        display_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('setup_required', 'connecting', 'connected', 'disconnected', 'error')),
        status_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_accounts_external
      ON messaging_accounts(owner_id, network_slug, external_account_id)
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_messaging_accounts_owner ON messaging_accounts(owner_id, updated_at DESC)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_setup_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        network_slug TEXT NOT NULL CHECK (network_slug IN ('telegram', 'whatsapp')),
        account_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'expired', 'cancelled')),
        setup_url TEXT,
        qr_code TEXT,
        pairing_code TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_messaging_setup_owner ON messaging_setup_sessions(owner_id, status, expires_at)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_conversations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        network_slug TEXT NOT NULL CHECK (network_slug IN ('telegram', 'whatsapp')),
        account_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        last_event_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(owner_id, room_id)
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_messaging_conversations_owner ON messaging_conversations(owner_id, updated_at DESC)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_conversation_mappings (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        network_slug TEXT NOT NULL CHECK (network_slug IN ('telegram', 'whatsapp')),
        account_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        external_thread_id TEXT NOT NULL,
        authoritative BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(owner_id, network_slug, account_id, external_thread_id)
      )
    `.execute(this.kysely);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messaging_mappings_room
      ON messaging_conversation_mappings(owner_id, room_id)
    `.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_permissions (
        owner_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        read_enabled BOOLEAN NOT NULL DEFAULT false,
        reply_enabled BOOLEAN NOT NULL DEFAULT false,
        automation_enabled BOOLEAN NOT NULL DEFAULT false,
        mention_only BOOLEAN NOT NULL DEFAULT true,
        revoked_at TIMESTAMPTZ,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(owner_id, room_id)
      )
    `.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_audit_events (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        network_slug TEXT,
        room_id TEXT,
        account_id TEXT,
        actor TEXT NOT NULL,
        safe_summary TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_messaging_audit_owner ON messaging_audit_events(owner_id, created_at DESC)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_event_cursors (
        owner_id TEXT NOT NULL,
        network_slug TEXT NOT NULL CHECK (network_slug IN ('telegram', 'whatsapp')),
        room_id TEXT,
        event_id TEXT NOT NULL,
        external_event_id TEXT,
        event_hash TEXT,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        effect TEXT NOT NULL,
        PRIMARY KEY(owner_id, network_slug, event_id)
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_messaging_event_cursors_room ON messaging_event_cursors(owner_id, room_id)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_outgoing_replies (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('user', 'hermes', 'automation')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'approval_required', 'sending', 'sent', 'failed', 'cancelled')),
        body TEXT NOT NULL,
        permission_revision INTEGER NOT NULL,
        client_txn_id TEXT NOT NULL,
        matrix_event_id TEXT,
        failure_code TEXT,
        cancel_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(owner_id, client_txn_id)
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_messaging_replies_drafts ON messaging_outgoing_replies(owner_id, status, created_at DESC)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS messaging_hermes_work_items (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('summarize', 'classify', 'draft_reply', 'automation')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancel_requested', 'cancelled', 'failed')),
        permission_revision INTEGER NOT NULL,
        abort_token_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_messaging_work_room ON messaging_hermes_work_items(owner_id, room_id, status)`.execute(this.kysely);
  }

  async destroy(): Promise<void> {
    if (this.ownsConnection) {
      await this.kysely.destroy();
    }
  }

  async listNetworks(): Promise<MessagingNetwork[]> {
    return MESSAGING_NETWORKS.map((network) => ({ ...network }));
  }

  async listAccounts(scope: MessagingOwnerScope): Promise<MessagingAccount[]> {
    const rows = await this.kysely
      .selectFrom("messaging_accounts")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .orderBy("updated_at", "desc")
      .execute();
    return rows.map(toAccount);
  }

  async getAccount(scope: MessagingOwnerScope, accountId: string): Promise<MessagingAccount | null> {
    const row = await this.kysely
      .selectFrom("messaging_accounts")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("id", "=", accountId)
      .executeTakeFirst();
    return row ? toAccount(row) : null;
  }

  async createSetupSession(input: CreateSetupSessionInput): Promise<SetupSession> {
    const network = MESSAGING_NETWORKS.find((candidate) => candidate.slug === input.networkSlug && candidate.enabled);
    if (!network) throw new MessagingError("bad_request", "unsupported network", 400);
    await this.expireStaleSetupSessions(input.ownerId);

    const setupId = prefixedId("setup");
    const provider = getMessagingBridgeAccountProvider(this.providers, input.networkSlug);
    let setupState: BridgeAccountSetupState;
    try {
      setupState = await provider.beginSetup({
        ownerId: input.ownerId,
        networkSlug: input.networkSlug,
        setupId,
      });
    } catch (err: unknown) {
      console.error("[messages/repository] Bridge setup failed", err instanceof Error ? err.name : typeof err);
      throw new MessagingError("provider_unavailable", "bridge setup failed", 503);
    }

    const expiresAt = setupState.expiresAt;
    const row = await this.kysely
      .insertInto("messaging_setup_sessions")
      .values({
        id: setupId,
        owner_id: input.ownerId,
        network_slug: input.networkSlug,
        account_id: null,
        status: "pending",
        setup_url: setupState.setupUrl ?? null,
        qr_code: setupState.qrCode ?? null,
        pairing_code: setupState.pairingCode ?? null,
        expires_at: expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSetupSession(row);
  }

  async completeSetupSession(input: CompleteSetupSessionInput): Promise<MessagingAccount> {
    return this.kysely.transaction().execute(async (trx) => {
      const setup = await trx
        .selectFrom("messaging_setup_sessions")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.setupId)
        .forUpdate()
        .executeTakeFirst();
      if (!setup) throw new MessagingError("not_found", "setup not found", 404);
      if (setup.status !== "pending") throw new MessagingError("conflict", "setup already completed", 409);
      if (isSetupExpired(setup.expires_at)) {
        await trx
          .updateTable("messaging_setup_sessions")
          .set({ status: "expired", updated_at: new Date().toISOString() })
          .where("id", "=", setup.id)
          .execute();
        throw new MessagingError("expired", "setup expired", 410);
      }

      const accountId = prefixedId("acct");
      const accountRow = await trx
        .insertInto("messaging_accounts")
        .values({
          id: accountId,
          owner_id: input.ownerId,
          network_slug: setup.network_slug,
          external_account_id: input.externalAccountId ?? null,
          display_name: input.displayName ?? null,
          status: "connected",
          status_reason: null,
        })
        .onConflict((oc) => oc
          .columns(["owner_id", "network_slug", "external_account_id"])
          .doUpdateSet({
            display_name: input.displayName ?? null,
            status: "connected",
            status_reason: null,
            updated_at: new Date().toISOString(),
          }))
        .returningAll()
        .executeTakeFirstOrThrow();

      const completedSetup = await trx
        .updateTable("messaging_setup_sessions")
        .set({ status: "complete", account_id: accountRow.id, updated_at: new Date().toISOString() })
        .where("id", "=", setup.id)
        .where("owner_id", "=", input.ownerId)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      if (!completedSetup) throw new MessagingError("conflict", "setup already completed", 409);

      return toAccount(accountRow);
    });
  }

  async disconnectAccount(input: DisconnectAccountInput): Promise<MessagingAccount> {
    const account = await this.getAccount({ ownerId: input.ownerId }, input.accountId);
    if (!account) throw new MessagingError("not_found", "account not found", 404);

    const updated = await this.kysely.transaction().execute(async (trx) => {
      if (input.retention === "delete_local_mapping") {
        await trx
          .deleteFrom("messaging_conversation_mappings")
          .where("owner_id", "=", input.ownerId)
          .where("account_id", "=", input.accountId)
          .execute();
      }

      return toAccount(await trx
        .updateTable("messaging_accounts")
        .set({ status: "disconnected", status_reason: null, updated_at: new Date().toISOString() })
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.accountId)
        .returningAll()
        .executeTakeFirstOrThrow());
    });

    const provider = getMessagingBridgeAccountProvider(this.providers, account.networkSlug);
    try {
      await provider.disconnect({
        ownerId: input.ownerId,
        networkSlug: account.networkSlug,
        accountId: input.accountId,
      });
    } catch (err: unknown) {
      console.error("[messages/repository] Bridge disconnect failed", err instanceof Error ? err.name : typeof err);
      await this.kysely
        .updateTable("messaging_accounts")
        .set({ status: "error", status_reason: "bridge disconnect failed", updated_at: new Date().toISOString() })
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.accountId)
        .execute();
      throw new MessagingError("provider_unavailable", "bridge disconnect failed", 503);
    }

    return updated;
  }

  async listConversations(
    scope: MessagingOwnerScope,
    options: MessagingListOptions = {},
  ): Promise<MessagingListResult<MatrixConversation>> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new MessagingError("bad_request", "invalid cursor", 400);
    }
    const rows = await this.kysely
      .selectFrom("messaging_conversations")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .orderBy("updated_at", "desc")
      .limit(limit + 1)
      .offset(offset)
      .execute();
    const page = rows.slice(0, limit).map(toConversation);
    return {
      items: page,
      nextCursor: rows.length > limit ? String(offset + limit) : undefined,
    };
  }

  async upsertConversation(input: UpsertConversationInput): Promise<MatrixConversation> {
    return this.kysely.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("messaging_conversations")
        .values({
          id: prefixedId("conv"),
          owner_id: input.ownerId,
          room_id: input.roomId,
          network_slug: input.networkSlug,
          account_id: input.accountId,
          display_name: input.displayName,
          avatar_url: input.avatarUrl ?? null,
          last_event_at: input.lastEventAt ?? null,
        })
        .onConflict((oc) => oc
          .columns(["owner_id", "room_id"])
          .doUpdateSet({
            network_slug: input.networkSlug,
            account_id: input.accountId,
            display_name: input.displayName,
            avatar_url: input.avatarUrl ?? null,
            last_event_at: input.lastEventAt ?? null,
            updated_at: new Date().toISOString(),
          }))
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("messaging_permissions")
        .values({
          owner_id: input.ownerId,
          room_id: input.roomId,
          read_enabled: false,
          reply_enabled: false,
          automation_enabled: false,
          mention_only: true,
          revision: 1,
        })
        .onConflict((oc) => oc.columns(["owner_id", "room_id"]).doNothing())
        .execute();

      return toConversation(row);
    });
  }

  async upsertConversationMapping(input: UpsertConversationMappingInput): Promise<ConversationMapping> {
    const row = await this.kysely
      .insertInto("messaging_conversation_mappings")
      .values({
        id: prefixedId("map"),
        owner_id: input.ownerId,
        network_slug: input.networkSlug,
        account_id: input.accountId,
        room_id: input.roomId,
        external_thread_id: input.externalThreadId,
        authoritative: input.authoritative,
      })
      .onConflict((oc) => oc
        .columns(["owner_id", "network_slug", "account_id", "external_thread_id"])
        .doUpdateSet({
          room_id: input.roomId,
          authoritative: input.authoritative,
          updated_at: new Date().toISOString(),
        }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMapping(row);
  }

  async getMappingByExternalThread(input: {
    ownerId: string;
    networkSlug: MessagingNetworkSlug;
    accountId: string;
    externalThreadId: string;
  }): Promise<ConversationMapping | null> {
    const row = await this.kysely
      .selectFrom("messaging_conversation_mappings")
      .selectAll()
      .where("owner_id", "=", input.ownerId)
      .where("network_slug", "=", input.networkSlug)
      .where("account_id", "=", input.accountId)
      .where("external_thread_id", "=", input.externalThreadId)
      .executeTakeFirst();
    return row ? toMapping(row) : null;
  }

  async getPermission(scope: MessagingOwnerScope, roomId: string): Promise<HermesPermission | null> {
    const row = await this.kysely
      .selectFrom("messaging_permissions")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("room_id", "=", roomId)
      .executeTakeFirst();
    return row ? toPermission(row) : null;
  }

  async getPermissions(scope: MessagingOwnerScope, roomIds: string[]): Promise<Record<string, HermesPermission>> {
    const uniqueRoomIds = [...new Set(roomIds)].slice(0, 100);
    if (uniqueRoomIds.length === 0) return {};
    const rows = await this.kysely
      .selectFrom("messaging_permissions")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("room_id", "in", uniqueRoomIds)
      .execute();
    return Object.fromEntries(rows.map((row) => [row.room_id, toPermission(row)]));
  }

  async updatePermission(input: UpdatePermissionInput): Promise<HermesPermission> {
    return this.kysely.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      const existing = await trx
        .selectFrom("messaging_permissions")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("room_id", "=", input.roomId)
        .executeTakeFirst();
      if (!existing) throw new MessagingError("not_found", "permission not found", 404);

      const updated = await trx
        .updateTable("messaging_permissions")
        .set({
          read_enabled: input.readEnabled,
          reply_enabled: input.replyEnabled,
          automation_enabled: input.automationEnabled,
          mention_only: input.mentionOnly,
          revoked_at: input.readEnabled || input.replyEnabled || input.automationEnabled ? null : now,
          revision: input.baseRevision + 1,
          updated_at: now,
        })
        .where("owner_id", "=", input.ownerId)
        .where("room_id", "=", input.roomId)
        .where("revision", "=", input.baseRevision)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new MessagingError("conflict", "permission revision conflict", 409);

      await this.insertAuditEvent(trx, {
        ownerId: input.ownerId,
        type: "permission_changed",
        actor: "owner",
        roomId: input.roomId,
        safeSummary: "Room messaging permissions changed",
        metadata: { revision: updated.revision, grantedBy: input.grantedBy },
      });

      const readRevoked = existing.read_enabled && !input.readEnabled;
      const replyRevoked = existing.reply_enabled && !input.replyEnabled;
      const automationRevoked = existing.automation_enabled && !input.automationEnabled;
      if (readRevoked || automationRevoked) {
        await trx
          .updateTable("messaging_hermes_work_items")
          .set({ status: "cancelled", updated_at: now })
          .where("owner_id", "=", input.ownerId)
          .where("room_id", "=", input.roomId)
          .where("status", "=", "queued")
          .execute();
        await trx
          .updateTable("messaging_hermes_work_items")
          .set({ status: "cancel_requested", updated_at: now })
          .where("owner_id", "=", input.ownerId)
          .where("room_id", "=", input.roomId)
          .where("status", "=", "running")
          .execute();
      }
      if (replyRevoked || readRevoked) {
        await trx
          .updateTable("messaging_outgoing_replies")
          .set({ status: "cancelled", cancel_reason: "permission_revoked", updated_at: now })
          .where("owner_id", "=", input.ownerId)
          .where("room_id", "=", input.roomId)
          .where("status", "in", ["draft", "approval_required", "sending"])
          .execute();
      }

      return toPermission(updated);
    });
  }

  async ingestBridgeEvent(input: IngestBridgeEventInput): Promise<IngestBridgeEventResult> {
    const permission = await this.getPermission({ ownerId: input.ownerId }, input.roomId);
    const canRead = Boolean(permission?.readEnabled) && (!permission?.mentionOnly || Boolean(input.content.mentionsOwner));
    const effect: BridgeEventEffect = canRead ? "sent_to_hermes" : "stored_only";
    const inserted = await this.kysely
      .insertInto("messaging_event_cursors")
      .values({
        owner_id: input.ownerId,
        network_slug: input.networkSlug,
        room_id: input.roomId,
        event_id: input.eventId,
        external_event_id: input.externalEventId ?? null,
        event_hash: null,
        processed_at: input.occurredAt,
        effect,
      })
      .onConflict((oc) => oc.columns(["owner_id", "network_slug", "event_id"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!inserted) return { accepted: false, effect: "ignored" };
    return { accepted: true, effect };
  }

  async createReply(input: CreateReplyInput): Promise<OutgoingReply> {
    const row = await this.kysely
      .insertInto("messaging_outgoing_replies")
      .values({
        id: prefixedId("reply"),
        owner_id: input.ownerId,
        room_id: input.roomId,
        source: input.source,
        status: input.status,
        body: input.body,
        permission_revision: input.permissionRevision,
        client_txn_id: input.clientTxnId,
        matrix_event_id: null,
        failure_code: null,
        cancel_reason: null,
      })
      .onConflict((oc) => oc
        .columns(["owner_id", "client_txn_id"])
        .doUpdateSet({ updated_at: new Date().toISOString() }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReply(row);
  }

  async createReplyAfterPermissionCheck(input: CreateReplyAfterPermissionCheckInput): Promise<ReplySendResult> {
    return this.kysely.transaction().execute(async (trx) => {
      const permission = await trx
        .selectFrom("messaging_permissions")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("room_id", "=", input.roomId)
        .forUpdate()
        .executeTakeFirst();
      const allowed = Boolean(permission?.reply_enabled);
      if (!allowed && input.mode === "send_if_allowed") {
        throw new MessagingError("forbidden", "reply permission missing", 403);
      }
      const status: OutgoingReplyStatus = allowed && input.mode !== "approval_required" ? "sent" : "approval_required";
      const matrixEventId = status === "sent" ? `$${input.clientTxnId}:matrixos.local` : null;
      const row = await trx
        .insertInto("messaging_outgoing_replies")
        .values({
          id: prefixedId("reply"),
          owner_id: input.ownerId,
          room_id: input.roomId,
          source: input.source,
          status,
          body: input.body,
          permission_revision: permission?.revision ?? 1,
          client_txn_id: input.clientTxnId,
          matrix_event_id: matrixEventId,
          failure_code: null,
          cancel_reason: null,
        })
        .onConflict((oc) => oc
          .columns(["owner_id", "client_txn_id"])
          .doUpdateSet({ updated_at: new Date().toISOString() }))
        .returningAll()
        .executeTakeFirstOrThrow();
      const reply = toReply(row);
      return { replyId: reply.id, status: reply.status, matrixEventId: reply.matrixEventId };
    });
  }

  async markReplySending(input: { ownerId: string; replyId: string }): Promise<OutgoingReply> {
    return this.updateReplyStatus(input.ownerId, input.replyId, { status: "sending" });
  }

  async markReplySent(input: { ownerId: string; replyId: string; matrixEventId: string }): Promise<OutgoingReply> {
    return this.updateReplyStatus(input.ownerId, input.replyId, { status: "sent", matrix_event_id: input.matrixEventId });
  }

  async markReplyFailed(input: { ownerId: string; replyId: string; failureCode: NonNullable<OutgoingReply["failureCode"]> }): Promise<OutgoingReply> {
    return this.updateReplyStatus(input.ownerId, input.replyId, { status: "failed", failure_code: input.failureCode });
  }

  async listDrafts(
    scope: MessagingOwnerScope,
    options: MessagingListOptions & { roomId?: string } = {},
  ): Promise<MessagingListResult<OutgoingReply>> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new MessagingError("bad_request", "invalid cursor", 400);
    let query = this.kysely
      .selectFrom("messaging_outgoing_replies")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("status", "in", ["draft", "approval_required"]);
    if (options.roomId) {
      query = query.where("room_id", "=", options.roomId);
    }
    const rows = await query.orderBy("created_at", "desc").limit(limit + 1).offset(offset).execute();
    return {
      items: rows.slice(0, limit).map(toReply),
      nextCursor: rows.length > limit ? String(offset + limit) : undefined,
    };
  }

  async getReply(input: { ownerId: string; replyId: string }): Promise<OutgoingReply | null> {
    const row = await this.kysely
      .selectFrom("messaging_outgoing_replies")
      .selectAll()
      .where("owner_id", "=", input.ownerId)
      .where("id", "=", input.replyId)
      .executeTakeFirst();
    return row ? toReply(row) : null;
  }

  async approveReply(input: ApproveReplyInput): Promise<ReplySendResult> {
    const reply = await this.kysely.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("messaging_outgoing_replies")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.replyId)
        .where("status", "=", input.baseStatus)
        .executeTakeFirst();
      if (!existing) throw new MessagingError("not_found", "reply not found", 404);
      const permission = await trx
        .selectFrom("messaging_permissions")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("room_id", "=", existing.room_id)
        .executeTakeFirst();
      if (!permission?.reply_enabled) throw new MessagingError("conflict", "reply permission missing", 409);
      return toReply(await trx
        .updateTable("messaging_outgoing_replies")
        .set({ status: "sending", updated_at: new Date().toISOString() })
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.replyId)
        .where("status", "=", input.baseStatus)
        .returningAll()
        .executeTakeFirstOrThrow());
    });
    return { replyId: reply.id, status: reply.status, matrixEventId: reply.matrixEventId };
  }

  async cancelReply(input: CancelReplyInput): Promise<ReplySendResult> {
    const existing = await this.getReply({ ownerId: input.ownerId, replyId: input.replyId });
    if (!existing) throw new MessagingError("not_found", "reply not found", 404);
    if (!["draft", "approval_required"].includes(existing.status)) {
      throw new MessagingError("conflict", "reply cannot be cancelled", 409);
    }
    const row = await this.kysely
      .updateTable("messaging_outgoing_replies")
      .set({ status: "cancelled", cancel_reason: input.reason, updated_at: new Date().toISOString() })
      .where("owner_id", "=", input.ownerId)
      .where("id", "=", input.replyId)
      .where("status", "in", ["draft", "approval_required"])
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new MessagingError("conflict", "reply cannot be cancelled", 409);
    const reply = toReply(row);
    return { replyId: reply.id, status: reply.status };
  }

  async enqueueHermesWork(input: EnqueueHermesWorkInput): Promise<HermesWorkItem> {
    const row = await this.kysely
      .insertInto("messaging_hermes_work_items")
      .values({
        id: prefixedId("work"),
        owner_id: input.ownerId,
        room_id: input.roomId,
        source_event_id: input.sourceEventId,
        kind: input.kind,
        status: input.status ?? "queued",
        permission_revision: input.permissionRevision,
        abort_token_id: prefixedId("abort"),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toWorkItem(row);
  }

  async listWorkItems(scope: MessagingOwnerScope & { roomId?: string }): Promise<HermesWorkItem[]> {
    let query = this.kysely
      .selectFrom("messaging_hermes_work_items")
      .selectAll()
      .where("owner_id", "=", scope.ownerId);
    if (scope.roomId) {
      query = query.where("room_id", "=", scope.roomId);
    }
    const rows = await query.orderBy("created_at", "asc").execute();
    return rows.map(toWorkItem);
  }

  private async expireStaleSetupSessions(ownerId: string): Promise<void> {
    await this.kysely
      .updateTable("messaging_setup_sessions")
      .set({ status: "expired", updated_at: new Date().toISOString() })
      .where("owner_id", "=", ownerId)
      .where("status", "=", "pending")
      .where("expires_at", "<=", new Date().toISOString())
      .execute();
  }

  private async updateReplyStatus(
    ownerId: string,
    replyId: string,
    patch: Partial<Pick<MessagingOutgoingRepliesTable, "status" | "matrix_event_id" | "failure_code" | "cancel_reason">>,
  ): Promise<OutgoingReply> {
    const row = await this.kysely
      .updateTable("messaging_outgoing_replies")
      .set({ ...patch, updated_at: new Date().toISOString() })
      .where("owner_id", "=", ownerId)
      .where("id", "=", replyId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new MessagingError("not_found", "reply not found", 404);
    return toReply(row);
  }

  private async insertAuditEvent(
    executor: Kysely<MessagingDatabase> | Transaction<MessagingDatabase>,
    input: MessagingAuditInput,
  ): Promise<void> {
    await executor
      .insertInto("messaging_audit_events")
      .values({
        id: prefixedId("audit"),
        owner_id: input.ownerId,
        type: input.type,
        network_slug: input.networkSlug ?? null,
        room_id: input.roomId ?? null,
        account_id: input.accountId ?? null,
        actor: input.actor,
        safe_summary: sanitizeAuditSummary(input.safeSummary),
        metadata: jsonb(input.metadata ?? {}),
      })
      .execute();
  }
}
