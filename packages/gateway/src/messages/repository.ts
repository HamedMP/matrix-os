import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type ColumnType, type Dialect, type Selectable } from "kysely";
import pg from "pg";
import { getMessagingBridgeAccountProvider, MESSAGING_NETWORKS } from "./bridge-accounts.js";
import { isSetupExpired } from "./setup-sessions.js";
import type {
  AccountSetupRequest,
  CompleteSetupRequest,
  ConversationMapping,
  DisconnectAccountRequest,
  MatrixConversation,
  MessagingAccount,
  MessagingNetwork,
  MessagingNetworkSlug,
  SetupSession,
} from "./schemas.js";
import { MessagingError } from "./errors.js";

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

export interface MessagingDatabase {
  messaging_accounts: MessagingAccountsTable;
  messaging_setup_sessions: MessagingSetupSessionsTable;
  messaging_conversations: MessagingConversationsTable;
  messaging_conversation_mappings: MessagingConversationMappingsTable;
}

function prefixedId(prefix: "acct" | "setup" | "conv" | "map"): string {
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

      await trx
        .updateTable("messaging_setup_sessions")
        .set({ status: "complete", account_id: accountRow.id, updated_at: new Date().toISOString() })
        .where("id", "=", setup.id)
        .where("owner_id", "=", input.ownerId)
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow();

      return toAccount(accountRow);
    });
  }

  async disconnectAccount(input: DisconnectAccountInput): Promise<MessagingAccount> {
    return this.kysely.transaction().execute(async (trx) => {
      const account = await trx
        .selectFrom("messaging_accounts")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.accountId)
        .executeTakeFirst();
      if (!account) throw new MessagingError("not_found", "account not found", 404);

      const provider = getMessagingBridgeAccountProvider(this.providers, account.network_slug);
      try {
        await provider.disconnect({
          ownerId: input.ownerId,
          networkSlug: account.network_slug,
          accountId: input.accountId,
        });
      } catch (err: unknown) {
        console.error("[messages/repository] Bridge disconnect failed", err instanceof Error ? err.name : typeof err);
        throw new MessagingError("provider_unavailable", "bridge disconnect failed", 503);
      }

      if (input.retention === "delete_local_mapping") {
        await trx
          .deleteFrom("messaging_conversation_mappings")
          .where("owner_id", "=", input.ownerId)
          .where("account_id", "=", input.accountId)
          .execute();
      }

      const updated = await trx
        .updateTable("messaging_accounts")
        .set({ status: "disconnected", status_reason: null, updated_at: new Date().toISOString() })
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.accountId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAccount(updated);
    });
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
    const row = await this.kysely
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
    return toConversation(row);
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

  private async expireStaleSetupSessions(ownerId: string): Promise<void> {
    await this.kysely
      .updateTable("messaging_setup_sessions")
      .set({ status: "expired", updated_at: new Date().toISOString() })
      .where("owner_id", "=", ownerId)
      .where("status", "=", "pending")
      .where("expires_at", "<=", new Date().toISOString())
      .execute();
  }
}
