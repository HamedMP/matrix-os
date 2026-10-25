import type { GmailConnectionMethod } from "@matrix-os/contracts/integration-marketplace";
import { isNativeGmailAccount, NATIVE_GMAIL_ACCOUNT } from "./native-gmail/request.js";

interface ConnectedAccountSource {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  scopes: string[];
  status: string;
  connected_at: Date | string;
  last_used_at: Date | string | null;
  pipedream_account_id?: string;
}

/** Transport is derived from the stored server identity, never the editable label. */
export function connectedAccountMethod(account: Pick<ConnectedAccountSource, "service" | "pipedream_account_id">): GmailConnectionMethod | undefined {
  if (account.service !== "gmail" || !account.pipedream_account_id) return undefined;
  if (isNativeGmailAccount(account.pipedream_account_id) && NATIVE_GMAIL_ACCOUNT.test(account.pipedream_account_id)) return "matrix";
  return /^apn_[A-Za-z0-9_-]{1,240}$/.test(account.pipedream_account_id) ? "pipedream" : undefined;
}

/** The list and sync routes share the same display-safe response boundary. */
export function projectConnectedAccount(account: ConnectedAccountSource) {
  const { id, service, account_label, account_email, scopes, status, connected_at, last_used_at } = account;
  const method = connectedAccountMethod(account);
  return { id, service, account_label, account_email, scopes, status, connected_at, last_used_at,
    ...(method ? { connection_method: method } : {}) };
}
