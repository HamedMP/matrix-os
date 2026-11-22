/**
 * The only error text the Mail app shows.
 *
 * Provider and gateway text never reaches the owner: anything caught is
 * reduced to a code, and the code picks one of the fixed sentences below.
 * Adapter-written messages are dropped too, so the set of sentences is closed.
 */
import {
  PROVIDER_ERROR_MESSAGES,
  isRetryableProviderError,
  toProviderError,
  type ProviderErrorCode,
} from "../../../_shared/office-accounts/types/mail";

/** Failures the Mail model detects itself, before or instead of a provider call. */
export const MAIL_LOCAL_ERROR_MESSAGES = Object.freeze({
  mixed_accounts: "Choose conversations from one account to move them.",
  unknown_folder: "That folder is not available.",
  nothing_selected: "Select a conversation first.",
  too_many_drafts: "Close a draft before starting another.",
  draft_invalid: "Check the recipients, subject and size of this draft.",
  thread_unavailable: "That conversation is not available.",
  no_account: "Connect a mail account first.",
  cache_unavailable: "Saved mail could not be loaded.",
} as const);

export type MailLocalErrorCode = keyof typeof MAIL_LOCAL_ERROR_MESSAGES;
export type MailErrorCode = ProviderErrorCode | MailLocalErrorCode;

/** A failure the UI can show as is. */
export interface MailError {
  code: MailErrorCode;
  message: string;
  /** True when a "Try again" action makes sense. */
  retryable: boolean;
}

const ALLOWED_MESSAGES: ReadonlySet<string> = new Set([
  ...Object.values(PROVIDER_ERROR_MESSAGES),
  ...Object.values(MAIL_LOCAL_ERROR_MESSAGES),
]);

export function localMailError(code: MailLocalErrorCode): MailError {
  return { code, message: MAIL_LOCAL_ERROR_MESSAGES[code], retryable: false };
}

/** Turns anything caught into an allowlisted, owner-facing error. */
export function toMailError(value: unknown): MailError {
  const error = toProviderError(value);
  return {
    code: error.code,
    message: PROVIDER_ERROR_MESSAGES[error.code],
    retryable: isRetryableProviderError(error),
  };
}

/** True only for text this module produced. UI code can assert with it. */
export function isAllowedMailErrorMessage(message: string): boolean {
  return ALLOWED_MESSAGES.has(message);
}

/** Writes the error name only: provider errors can carry account details. */
export type MailLogger = (event: string, error?: unknown) => void;

export const defaultMailLogger: MailLogger = (event, error) => {
  const name = error instanceof Error ? error.name : error === undefined ? "" : typeof error;
  console.warn(`[mail] ${event}${name ? ` (${name})` : ""}`);
};
