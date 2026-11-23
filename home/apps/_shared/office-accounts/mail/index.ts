/**
 * Mail adapters behind the `MailProvider` contract. Apps build one provider per
 * account with `createMailProvider` and never call integration actions directly.
 */
import type { MailAccount, MailProvider } from "../types/mail.js";
import { defaultBridge, type ServiceBridge } from "./bridge.js";
import { createGmailProvider } from "./gmail-provider.js";
import { createOutlookProvider } from "./outlook-provider.js";

export { createGmailProvider } from "./gmail-provider.js";
export { createOutlookProvider } from "./outlook-provider.js";
export { GMAIL_ARCHIVE_ID } from "./gmail-normalize.js";
export { OUTLOOK_STARRED_ID } from "./outlook-normalize.js";
export { defaultBridge, type ServiceBridge } from "./bridge.js";
export type { MailAdapterOptions } from "./provider-options.js";

/**
 * The adapter for one account. `account.label` (from `listMailAccounts`) is the
 * integration label every call carries; without it a second connected account
 * of the same provider makes calls fail with `multiple_accounts`.
 */
export function createMailProvider(account: MailAccount & { label?: string }, bridge: ServiceBridge = defaultBridge()): MailProvider {
  const options = { account, label: account.label, bridge };
  return account.provider === "gmail" ? createGmailProvider(options) : createOutlookProvider(options);
}
