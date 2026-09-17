import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SyncDeviceRefreshTokenSchema } from "@matrix-os/contracts";
import type { PlatformDB, SyncDeviceGrantsTable } from "./db.js";
import { timingSafeTokenEquals } from "./platform-token.js";

const REFRESH_SECRET_BYTES = 32;
const DEFAULT_REFRESH_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export class SyncDeviceGrantError extends Error {
  constructor(readonly code: "invalid_grant" | "grant_expired" | "grant_replayed") {
    super(code);
    this.name = "SyncDeviceGrantError";
  }
}

export interface SyncDeviceGrantCredential {
  grant: SyncDeviceGrantsTable;
  refreshToken: string;
}

export interface SyncDeviceGrantStore {
  enroll(input: {
    clerkUserId: string;
    runtimeSlot: string;
    handle: string;
    deviceName: string;
  }): Promise<SyncDeviceGrantCredential>;
  rotate(refreshToken: string): Promise<SyncDeviceGrantCredential>;
  revoke(refreshToken: string): Promise<void>;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issueRefreshToken(
  randomId: () => string,
  randomSecret: () => Buffer,
): { id: string; token: string; hash: string } {
  const id = randomId();
  const token = `sdr_${id}.${randomSecret().toString("base64url")}`;
  return { id, token, hash: hashToken(token) };
}

function grantIdFromToken(token: string): string {
  const parsed = SyncDeviceRefreshTokenSchema.safeParse(token);
  if (!parsed.success) throw new SyncDeviceGrantError("invalid_grant");
  return parsed.data.slice(4, parsed.data.indexOf("."));
}

export function createSyncDeviceGrantStore(options: {
  db: PlatformDB;
  now?: () => number;
  refreshLifetimeMs?: number;
  randomId?: () => string;
  randomSecret?: () => Buffer;
}): SyncDeviceGrantStore {
  const now = options.now ?? Date.now;
  const refreshLifetimeMs = options.refreshLifetimeMs ?? DEFAULT_REFRESH_LIFETIME_MS;
  const randomId = options.randomId ?? randomUUID;
  const randomSecret = options.randomSecret ?? (() => randomBytes(REFRESH_SECRET_BYTES));

  return {
    async enroll(input) {
      const issued = issueRefreshToken(randomId, randomSecret);
      const timestamp = now();
      const grant: SyncDeviceGrantsTable = {
        id: issued.id,
        clerk_user_id: input.clerkUserId,
        runtime_slot: input.runtimeSlot,
        handle: input.handle,
        device_name: input.deviceName,
        refresh_token_hash: issued.hash,
        previous_refresh_token_hash: null,
        generation: 0,
        expires_at: timestamp + refreshLifetimeMs,
        created_at: timestamp,
        updated_at: timestamp,
        last_used_at: null,
        revoked_at: null,
      };
      await options.db.executor.insertInto("sync_device_grants").values(grant).execute();
      return { grant, refreshToken: issued.token };
    },

    async rotate(refreshToken) {
      const grantId = grantIdFromToken(refreshToken);
      const presentedHash = hashToken(refreshToken);
      const outcome = await options.db.transaction(async (transaction) => {
        const grant = await transaction.executor
          .selectFrom("sync_device_grants")
          .selectAll()
          .where("id", "=", grantId)
          .executeTakeFirst();
        if (!grant || grant.revoked_at !== null) {
          throw new SyncDeviceGrantError("invalid_grant");
        }
        const timestamp = now();
        if (grant.expires_at <= timestamp) {
          await transaction.executor
            .updateTable("sync_device_grants")
            .set({ revoked_at: timestamp, updated_at: timestamp })
            .where("id", "=", grant.id)
            .where("revoked_at", "is", null)
            .execute();
          return { error: "grant_expired" as const };
        }
        if (
          grant.previous_refresh_token_hash !== null
          && timingSafeTokenEquals(presentedHash, grant.previous_refresh_token_hash)
        ) {
          await transaction.executor
            .updateTable("sync_device_grants")
            .set({ revoked_at: timestamp, updated_at: timestamp })
            .where("id", "=", grant.id)
            .where("revoked_at", "is", null)
            .execute();
          return { error: "grant_replayed" as const };
        }
        if (!timingSafeTokenEquals(presentedHash, grant.refresh_token_hash)) {
          throw new SyncDeviceGrantError("invalid_grant");
        }

        const next = issueRefreshToken(() => grant.id, randomSecret);
        const updated = await transaction.executor
          .updateTable("sync_device_grants")
          .set({
            refresh_token_hash: next.hash,
            previous_refresh_token_hash: grant.refresh_token_hash,
            generation: grant.generation + 1,
            last_used_at: timestamp,
            updated_at: timestamp,
          })
          .where("id", "=", grant.id)
          .where("generation", "=", grant.generation)
          .where("refresh_token_hash", "=", grant.refresh_token_hash)
          .where("revoked_at", "is", null)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw new SyncDeviceGrantError("invalid_grant");
        return { credential: { grant: updated, refreshToken: next.token } };
      });
      if (outcome.error) throw new SyncDeviceGrantError(outcome.error);
      return outcome.credential;
    },

    async revoke(refreshToken) {
      let grantId: string;
      try {
        grantId = grantIdFromToken(refreshToken);
      } catch (err: unknown) {
        if (err instanceof SyncDeviceGrantError) return;
        throw err;
      }
      const timestamp = now();
      const presentedHash = hashToken(refreshToken);
      await options.db.transaction(async (transaction) => {
        const grant = await transaction.executor
          .selectFrom("sync_device_grants")
          .select(["refresh_token_hash", "previous_refresh_token_hash"])
          .where("id", "=", grantId)
          .where("revoked_at", "is", null)
          .executeTakeFirst();
        if (!grant) return;
        const matchesCurrent = timingSafeTokenEquals(presentedHash, grant.refresh_token_hash);
        const matchesPrevious = grant.previous_refresh_token_hash !== null
          && timingSafeTokenEquals(presentedHash, grant.previous_refresh_token_hash);
        if (!matchesCurrent && !matchesPrevious) return;
        await transaction.executor
          .updateTable("sync_device_grants")
          .set({ revoked_at: timestamp, updated_at: timestamp })
          .where("id", "=", grantId)
          .where("revoked_at", "is", null)
          .execute();
      });
    },
  };
}
