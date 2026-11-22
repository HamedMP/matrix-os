import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { sql, type ColumnType, type Kysely } from "kysely";
import { z } from "zod/v4";
import { MessagingBridgeLoginStepSchema, MessagingBridgeNetworkSchema, type MessagingBridgeNetwork } from "@matrix-os/contracts/messaging-bridge";
import type { PendingNativeStep } from "./step-normalizer.js";

/**
 * Pending bridge login processes and the per-owner login-start rate limit,
 * shared by every platform instance through platform Postgres (spec 2701).
 * The bridge holds the login itself; a row records which owner started it (a
 * process id alone is never trusted) and the current step the platform must
 * submit next. That step can carry a QR or pairing code, so it is stored only
 * AES-256-GCM encrypted and bound to its row. Login field values are never
 * stored. Rows are capped per owner, expire 10 minutes after their last step,
 * are deleted when the flow ends, and expired rows are claimed and cancelled
 * at the bridge by whichever instance sees them first.
 */
export const LOGIN_PROCESS_TTL_MS = 10 * 60_000;
export const LOGIN_PROCESS_CAP_PER_OWNER = 16;
export const LOGIN_START_LIMIT = 5;
export const LOGIN_START_WINDOW_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 100;
const MAX_PENDING_BYTES = 65_536;

export interface MessagingBridgeLoginsTable {
  network: string;
  process_id: string;
  owner_id: string;
  matrix_user_id: string;
  pending_step: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

export interface MessagingBridgeLoginStartsTable {
  id: ColumnType<number, never, never>;
  owner_id: string;
  started_at: ColumnType<Date, Date | string, never>;
}

export interface MessagingBridgeLoginDatabase {
  messaging_bridge_logins: MessagingBridgeLoginsTable;
  messaging_bridge_login_starts: MessagingBridgeLoginStartsTable;
}

export async function createMessagingBridgeLoginTables(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS messaging_bridge_logins (
      network TEXT NOT NULL CHECK (network IN ('whatsapp', 'telegram', 'linkedin')),
      process_id TEXT NOT NULL CHECK (char_length(process_id) BETWEEN 1 AND 128),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 160),
      matrix_user_id TEXT NOT NULL CHECK (char_length(matrix_user_id) BETWEEN 3 AND 255),
      pending_step TEXT NOT NULL CHECK (char_length(pending_step) <= 131072),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (network, process_id)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS messaging_bridge_logins_owner_idx ON messaging_bridge_logins (owner_id, expires_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS messaging_bridge_logins_expiry_idx ON messaging_bridge_logins (expires_at)`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS messaging_bridge_login_starts (
      id BIGSERIAL PRIMARY KEY,
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 160),
      started_at TIMESTAMPTZ NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS messaging_bridge_login_starts_owner_idx ON messaging_bridge_login_starts (owner_id, started_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS messaging_bridge_login_starts_time_idx ON messaging_bridge_login_starts (started_at)`.execute(db);
}

export interface LoginProcessRecord {
  ownerId: string;
  network: MessagingBridgeNetwork;
  /** The owner's homeserver user the bridge process acts for. */
  userId: string;
  pending: PendingNativeStep;
}

/** A process removed by expiry or the per-owner cap; cancel it at the bridge. */
export interface AbandonedLogin {
  processId: string;
  network: MessagingBridgeNetwork;
  userId: string;
}

const PendingNativeStepSchema = z.object({
  stepId: z.string().min(1).max(128),
  nativeType: z.enum(["display_and_wait", "user_input", "cookies"]),
  txnId: z.string().min(1).max(128).optional(),
  fieldIds: z.array(z.object({
    id: z.string().min(1).max(128),
    required: z.boolean(),
    options: z.array(z.string().max(280)).max(50).optional(),
  }).strict()).max(12),
  step: MessagingBridgeLoginStepSchema,
}).strict();

class PendingStepCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Domain-separated from the owner-id derivation that uses the same secret.
    this.key = createHmac("sha256", secret).update("messaging-bridge-login-step-v1").digest();
  }

  private static aad(network: string, processId: string, ownerId: string): Buffer {
    return Buffer.from(`${network}\0${processId}\0${ownerId}`, "utf8");
  }

  seal(pending: PendingNativeStep, network: string, processId: string, ownerId: string): string {
    const clear = Buffer.from(JSON.stringify(pending), "utf8");
    if (clear.length > MAX_PENDING_BYTES) throw new Error("Pending login step is too large");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(PendingStepCipher.aad(network, processId, ownerId));
    const sealed = Buffer.concat([cipher.update(clear), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), sealed.toString("base64url")].join(".");
  }

  /** Null when the value cannot be opened (e.g. after a key rotation); the row is then treated as gone. */
  open(value: string, network: string, processId: string, ownerId: string): PendingNativeStep | null {
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    let clear: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(PendingStepCipher.aad(network, processId, ownerId));
      decipher.setAuthTag(tag);
      clear = Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
    } catch (error: unknown) {
      // GCM authentication failure is the only expected error here.
      if (error instanceof Error) return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(clear);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    const result = PendingNativeStepSchema.safeParse(parsed);
    return result.success ? (result.data as PendingNativeStep) : null;
  }
}

function abandoned(rows: Array<{ network: string; process_id: string; matrix_user_id: string }>): AbandonedLogin[] {
  const out: AbandonedLogin[] = [];
  for (const row of rows) {
    const network = MessagingBridgeNetworkSchema.safeParse(row.network);
    if (network.success) out.push({ processId: row.process_id, network: network.data, userId: row.matrix_user_id });
  }
  return out;
}

/** Serializes one owner's cap and rate-limit checks across instances for the rest of the transaction. */
async function lockOwner(db: Kysely<MessagingBridgeLoginDatabase>, ownerId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`messaging-bridge-login:${ownerId}`}))`.execute(db);
}

export interface MessagingBridgeLoginStore {
  /** Counts the attempt and returns false when the owner is over the start limit. */
  tryStart(ownerId: string, at: number): Promise<boolean>;
  /** Record or refresh a pending process for its owner; returns processes evicted by the per-owner cap. */
  put(processId: string, record: LoginProcessRecord, at: number): Promise<AbandonedLogin[]>;
  /** The process only if it is live and was started by this owner on this network; an expired one is claimed. */
  get(processId: string, ownerId: string, network: MessagingBridgeNetwork, at: number): Promise<{ record?: LoginProcessRecord; abandoned?: AbandonedLogin }>;
  /** Removes the owner's process; returns it when one existed. */
  delete(processId: string, ownerId: string, network: MessagingBridgeNetwork): Promise<AbandonedLogin | undefined>;
  /** Claims a bounded batch of expired processes and prunes old start records. */
  sweep(at: number): Promise<AbandonedLogin[]>;
}

export function createMessagingBridgeLoginStore(db: Kysely<MessagingBridgeLoginDatabase>, secret: string): MessagingBridgeLoginStore {
  const cipher = new PendingStepCipher(secret);

  return {
    async tryStart(ownerId, at) {
      const windowStart = new Date(at - LOGIN_START_WINDOW_MS);
      return db.transaction().execute(async (trx) => {
        await lockOwner(trx, ownerId);
        await trx.deleteFrom("messaging_bridge_login_starts")
          .where("owner_id", "=", ownerId)
          .where("started_at", "<=", windowStart)
          .execute();
        const { count } = await trx.selectFrom("messaging_bridge_login_starts")
          .select(eb => eb.fn.countAll<string>().as("count"))
          .where("owner_id", "=", ownerId)
          .executeTakeFirstOrThrow();
        if (Number(count) >= LOGIN_START_LIMIT) return false;
        await trx.insertInto("messaging_bridge_login_starts").values({ owner_id: ownerId, started_at: new Date(at) }).execute();
        return true;
      });
    },

    async put(processId, record, at) {
      const sealed = cipher.seal(record.pending, record.network, processId, record.ownerId);
      return db.transaction().execute(async (trx) => {
        await lockOwner(trx, record.ownerId);
        // Idempotent; a row owned by someone else is never overwritten.
        await trx.insertInto("messaging_bridge_logins")
          .values({
            network: record.network,
            process_id: processId,
            owner_id: record.ownerId,
            matrix_user_id: record.userId,
            pending_step: sealed,
            expires_at: new Date(at + LOGIN_PROCESS_TTL_MS),
          })
          .onConflict(conflict => conflict.columns(["network", "process_id"]).doUpdateSet(eb => ({
            matrix_user_id: eb.ref("excluded.matrix_user_id"),
            pending_step: eb.ref("excluded.pending_step"),
            expires_at: eb.ref("excluded.expires_at"),
          })).where("messaging_bridge_logins.owner_id", "=", record.ownerId))
          .execute();
        const evicted = await trx.deleteFrom("messaging_bridge_logins")
          .where("owner_id", "=", record.ownerId)
          .where(eb => eb(eb.refTuple("network", "process_id"), "in",
            eb.selectFrom("messaging_bridge_logins")
              .select(["network", "process_id"])
              .where("owner_id", "=", record.ownerId)
              .orderBy("expires_at", "desc")
              .orderBy("process_id", "desc")
              .offset(LOGIN_PROCESS_CAP_PER_OWNER)
              .limit(SWEEP_BATCH)
              .$asTuple("network", "process_id")))
          .returning(["network", "process_id", "matrix_user_id"])
          .execute();
        return abandoned(evicted);
      });
    },

    async get(processId, ownerId, network, at) {
      const row = await db.selectFrom("messaging_bridge_logins")
        .select(["matrix_user_id", "pending_step", "expires_at"])
        .where("network", "=", network)
        .where("process_id", "=", processId)
        .where("owner_id", "=", ownerId)
        .executeTakeFirst();
      if (!row) return {};
      const expired = new Date(row.expires_at).getTime() <= at;
      const pending = expired ? null : cipher.open(row.pending_step, network, processId, ownerId);
      if (pending) return { record: { ownerId, network, userId: row.matrix_user_id, pending } };
      // Expired or unreadable: claim it so exactly one instance cancels it at the bridge.
      const claimed = await db.deleteFrom("messaging_bridge_logins")
        .where("network", "=", network)
        .where("process_id", "=", processId)
        .where("owner_id", "=", ownerId)
        .returning(["network", "process_id", "matrix_user_id"])
        .execute();
      const [gone] = abandoned(claimed);
      return gone ? { abandoned: gone } : {};
    },

    async delete(processId, ownerId, network) {
      const rows = await db.deleteFrom("messaging_bridge_logins")
        .where("network", "=", network)
        .where("process_id", "=", processId)
        .where("owner_id", "=", ownerId)
        .returning(["network", "process_id", "matrix_user_id"])
        .execute();
      return abandoned(rows)[0];
    },

    async sweep(at) {
      const now = new Date(at);
      const claimed = await db.deleteFrom("messaging_bridge_logins")
        .where(eb => eb(eb.refTuple("network", "process_id"), "in",
          eb.selectFrom("messaging_bridge_logins")
            .select(["network", "process_id"])
            .where("expires_at", "<=", now)
            .limit(SWEEP_BATCH)
            .$asTuple("network", "process_id")))
        .returning(["network", "process_id", "matrix_user_id"])
        .execute();
      await db.deleteFrom("messaging_bridge_login_starts")
        .where("started_at", "<=", new Date(at - LOGIN_START_WINDOW_MS))
        .execute();
      return abandoned(claimed);
    },
  };
}

/** One unref'd timer for the shared sweep; returns the stop function used on shutdown. */
export function startLoginSweeper(run: () => Promise<void>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void run().finally(() => {
      running = false;
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
