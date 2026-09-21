/**
 * Home runtime identity (S05 / T026, T027): one Ed25519 key pair generated
 * on first boot and kept in the owner database, whose public half the home
 * registers with the platform. Gateway migration 9 owns the table.
 */
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { generateRuntimeKeyPair } from "./direct-crypto.js";
import type { OwnerCollaborationDatabase } from "./database.js";

export interface CollaborationRuntimeIdentityTable {
  singleton: number;
  key_id: string;
  seed: string;
  public_key: string;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export async function migrateRuntimeIdentityV9(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_runtime_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 80),
      seed TEXT NOT NULL CHECK (char_length(seed) = 43),
      public_key TEXT NOT NULL CHECK (char_length(public_key) = 43),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(trx);
  await sql`INSERT INTO collaboration_schema_migrations (version) VALUES (9) ON CONFLICT (version) DO NOTHING`.execute(trx);
}

export interface RuntimeIdentity {
  keyId: string;
  seed: string;
  publicKey: string;
}

/** Idempotent: a concurrent first boot keeps whichever row won the insert. */
export async function ensureRuntimeIdentity(db: Kysely<OwnerCollaborationDatabase>): Promise<RuntimeIdentity> {
  const existing = await db.selectFrom("collaboration_runtime_identity").selectAll().where("singleton", "=", 1).executeTakeFirst();
  if (existing) return { keyId: existing.key_id, seed: existing.seed, publicKey: existing.public_key };
  const generated = generateRuntimeKeyPair();
  const keyId = `home-${Date.now().toString(36)}`;
  await db.insertInto("collaboration_runtime_identity")
    .values({ singleton: 1, key_id: keyId, seed: generated.seed, public_key: generated.publicKey })
    .onConflict((oc) => oc.column("singleton").doNothing())
    .execute();
  const row = await db.selectFrom("collaboration_runtime_identity").selectAll().where("singleton", "=", 1).executeTakeFirstOrThrow();
  return { keyId: row.key_id, seed: row.seed, publicKey: row.public_key };
}
