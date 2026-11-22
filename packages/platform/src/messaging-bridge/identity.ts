import { createHmac } from "node:crypto";
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { MatrixUserIdSchema } from "@matrix-os/contracts/messaging-bridge";
import { runPlatformMigration } from "../migration-runner.js";

/**
 * Owner -> shared-homeserver identity (spec 2701). The Matrix user id is a
 * keyed hash of the verified owner id, so a gateway cannot name another
 * owner's user. Localparts are `mxo_` plus lowercase hex: the bridge host
 * scopes Synapse and its double-puppet appservice to exactly that shape. The first derived id is persisted and wins thereafter, so a
 * later key rotation cannot silently orphan an owner's bridge logins. No
 * tokens are stored.
 */
export interface MessagingBridgeIdentitiesTable {
  owner_id: string;
  matrix_user_id: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface MessagingBridgeDatabase {
  messaging_bridge_identities: MessagingBridgeIdentitiesTable;
}

export const MESSAGING_BRIDGE_SCHEMA_REVISION = { generation: 1, fingerprint: "messaging-bridge-identities-v1" } as const;

const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

async function createMessagingBridgeTables(db: Transaction<MessagingBridgeDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS messaging_bridge_identities (
      owner_id TEXT PRIMARY KEY CHECK (char_length(owner_id) BETWEEN 1 AND 160),
      matrix_user_id TEXT NOT NULL UNIQUE CHECK (char_length(matrix_user_id) BETWEEN 3 AND 255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function bootstrapMessagingBridgeDatabase(db: Kysely<MessagingBridgeDatabase>): Promise<void> {
  await runPlatformMigration(db, createMessagingBridgeTables, {
    scope: "messaging-bridge", revision: MESSAGING_BRIDGE_SCHEMA_REVISION, deadlockAttempts: 12,
  });
}

export function deriveMatrixUserId(userIdKey: string, ownerId: string, serverName: string): string {
  const digest = createHmac("sha256", userIdKey).update(ownerId).digest("hex").slice(0, 32);
  return MatrixUserIdSchema.parse(`@mxo_${digest}:${serverName}`);
}

export interface MessagingBridgeIdentityStore {
  /** Idempotently records the owner's identity and returns the persisted Matrix user id. */
  ensure(ownerId: string, derivedUserId: string): Promise<string>;
}

export function createMessagingBridgeIdentityStore(db: Kysely<MessagingBridgeDatabase>): MessagingBridgeIdentityStore {
  return {
    async ensure(ownerId, derivedUserId) {
      if (!OWNER_ID_PATTERN.test(ownerId)) throw new Error("Invalid owner id");
      await db.insertInto("messaging_bridge_identities")
        .values({ owner_id: ownerId, matrix_user_id: derivedUserId })
        .onConflict(conflict => conflict.column("owner_id").doNothing())
        .execute();
      const row = await db.selectFrom("messaging_bridge_identities")
        .select("matrix_user_id")
        .where("owner_id", "=", ownerId)
        .executeTakeFirstOrThrow();
      return MatrixUserIdSchema.parse(row.matrix_user_id);
    },
  };
}
