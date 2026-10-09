import { type Kysely, sql } from "kysely";
import type { PlatformDatabase } from "../../platform-db.js";
import type { CustomMcpStatus } from "./types.js";

/** Credential CAS does not alter the independently enforced tool-policy revision. */
export function createCustomMcpCredentialMutations(db: Kysely<PlatformDatabase>) {
  return {
    /** Fence refresh ciphertext and tool policy together before revocation/removal. */
    async claimCustomMcpRemovalIfCurrent(id: string, userId: string, revision: number,
      expectedEncrypted: string | null, removalEncrypted: string | null): Promise<boolean> {
      const row = await db.updateTable("custom_mcp_servers").set({
        encrypted_credentials: removalEncrypted, enabled: false, status: "disabled",
        action_required_reason: "credential_removal_in_progress",
        revision: sql`revision + 1`, updated_at: sql`now()`,
      }).where("id", "=", id).where("user_id", "=", userId).where("revision", "=", revision)
        .where("encrypted_credentials", expectedEncrypted === null ? "is" : "=", expectedEncrypted)
        // Cleanup has a bounded lease: retries may recover a crashed remover, but
        // must not replace an active claim even after reading its new revision.
        .where(sql<boolean>`(action_required_reason IS DISTINCT FROM 'credential_removal_in_progress'
          OR updated_at <= now() - interval '60 seconds')`)
        .returning("id").executeTakeFirst();
      return Boolean(row);
    },
    async updateCustomMcpCredentialsIfCurrent(id: string, userId: string, revision: number,
      expectedEncrypted: string | null, encryptedCredentials: string, status: CustomMcpStatus, advanceRevision = false): Promise<boolean> {
      const row = await db.updateTable("custom_mcp_servers").set({
        encrypted_credentials: encryptedCredentials, status, updated_at: sql`now()`,
        ...(advanceRevision ? { revision: sql<number>`revision + 1` } : {}),
      }).where("id", "=", id).where("user_id", "=", userId).where("revision", "=", revision)
        .where("encrypted_credentials", expectedEncrypted === null ? "is" : "=", expectedEncrypted).returning("id").executeTakeFirst();
      return Boolean(row);
    },
    /** A refresh claim owns the grant, independently of later owner policy edits. */
    async settleCustomMcpRefreshIfCurrent(id: string, userId: string, expectedEncrypted: string,
      encryptedCredentials: string, authorizationRequired = false): Promise<boolean> {
      const row = await db.updateTable("custom_mcp_servers").set({
        encrypted_credentials: encryptedCredentials, updated_at: sql`now()`,
        ...(authorizationRequired ? { status: "action_required" as const } : {}),
      }).where("id", "=", id).where("user_id", "=", userId).where("auth_mode", "=", "oauth")
        .where("encrypted_credentials", "=", expectedEncrypted).returning("id").executeTakeFirst();
      return Boolean(row);
    },
    async deleteCustomMcpServerIfRevision(id: string, userId: string, revision: number): Promise<boolean> {
      const row = await db.deleteFrom("custom_mcp_servers").where("id", "=", id)
        .where("user_id", "=", userId).where("revision", "=", revision).returning("id").executeTakeFirst();
      return Boolean(row);
    },
  };
}
