/**
 * What every mail adapter is built from, and the message-body cache they share.
 */
import type { MailAccount, MailMessage } from "../types/mail.js";
import type { ServiceBridge } from "./bridge.js";
import { LruCache } from "./support.js";

export interface MailAdapterOptions {
  account: MailAccount;
  /**
   * The integration account label (`MatrixOSConnectedService.account_label`).
   * Required when several accounts of the provider are connected; without it
   * the gateway answers `multiple_accounts`.
   */
  label?: string;
  bridge: ServiceBridge;
}

/** At most this many full messages are kept per adapter. */
export const MESSAGE_CACHE_ENTRIES = 200;
/** Total body characters (text plus HTML) kept per adapter, about 16 MB of UTF-16. */
export const MESSAGE_CACHE_CHARS = 8_000_000;

function messageWeight(message: MailMessage): number {
  return message.bodyText.length + (message.bodyHtml?.length ?? 0) + message.subject.length + 256;
}

/** A size-capped LRU of normalised messages by message id. */
export function createMessageCache(): LruCache<string, MailMessage> {
  return new LruCache<string, MailMessage>(MESSAGE_CACHE_ENTRIES, MESSAGE_CACHE_CHARS, messageWeight);
}
