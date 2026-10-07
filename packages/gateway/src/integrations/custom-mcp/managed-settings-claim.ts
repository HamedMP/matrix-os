import type { CustomMcpServerBrokerRow } from "../../platform-db.js";
import { decryptCustomMcpCredential } from "./crypto.js";

/** Removal and Bokio claims settle against a row revision; settings must wait. */
export function hasManagedSettingsClaim(row: CustomMcpServerBrokerRow, encryptionKey: Buffer): boolean {
  // Applies to all auth modes, including credential-free servers. Failed
  // cleanup retains the fence until explicit disconnect recovery succeeds.
  if (row.action_required_reason === "credential_removal_in_progress"
    || row.action_required_reason === "credential_revocation_failed") return true;
  if (!row.encrypted_credentials || (row.preset_id !== "bokio" && row.auth_mode !== "oauth")) return false;
  try {
    const credential = decryptCustomMcpCredential<Record<string, unknown>>(row.encrypted_credentials, encryptionKey,
      { userId: row.user_id, serverId: row.id });
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) return true;
    if (row.preset_id !== "bokio") {
      // Older OAuth removal claims predate the database reason. Refresh policy
      // changes remain allowed because exact-cipher settlement preserves them.
      const oauth = credential.oauth;
      return Boolean(oauth && typeof oauth === "object" && !Array.isArray(oauth)
        && (oauth as Record<string, unknown>).removing);
    }
    if (credential.kind !== "bokio") return true;
    // Expired claims require explicit OAuth/disconnect recovery before editing;
    // their old code or rotating token may already have been consumed remotely.
    return Boolean(credential.refreshing || credential.authorizing || credential.removingAt);
  } catch (error: unknown) {
    console.warn("[custom-mcp] managed settings credential unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return true;
  }
}
