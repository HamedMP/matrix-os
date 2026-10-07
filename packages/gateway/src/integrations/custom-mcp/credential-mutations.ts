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
        revision: sql`revision + 1`, updated_at: sql`now()`,
      }).where("id", "=", id).where("user_id", "=", userId).where("revision", "=", revision)
        .where("encrypted_credentials", expectedEncrypted === null ? "is" : "=", expectedEncrypted)
        .returning("id").executeTakeFirst();
      return Boolean(row);
    },
    async updateCustomMcpCredentialsIfCurrent(id: string, userId: string, revision: number,
      expectedEncrypted: string, encryptedCredentials: string, status: CustomMcpStatus): Promise<boolean> {
      const row = await db.updateTable("custom_mcp_servers").set({
        encrypted_credentials: encryptedCredentials, status, updated_at: sql`now()`,
      }).where("id", "=", id).where("user_id", "=", userId).where("revision", "=", revision)
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
