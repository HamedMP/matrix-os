/**
 * Typed failures of the Mail agent. The message is always one of the fixed
 * sentences below, so the UI can show it as is; provider, bridge and model
 * text never reaches the owner.
 */
import { toMailError } from "../model/errors";

export const MAIL_AGENT_ERROR_MESSAGES = Object.freeze({
  ai_unavailable: "The assistant is not available here.",
  ai_failed: "The assistant could not answer. Try again.",
  invalid_reply: "The assistant's answer could not be used. Try again.",
  prompt_too_large: "This request is too large for the assistant.",
  cancelled: "Stopped.",
  no_thread: "Open a conversation first.",
  no_account: "Connect a mail account first.",
  no_recipient: "No email address was found for this row.",
  provider_failed: "Your mailbox could not be reached. Try again.",
  too_many_rows: "Use at most 200 rows.",
  nothing_selected: "Select at least one item first.",
  not_confirmed: "Sending needs your confirmation.",
  draft_invalid: "Check the recipients, subject and size of this draft.",
  draft_unavailable: "The draft could not be opened. Close a draft and try again.",
} as const);

export type MailAgentErrorCode = keyof typeof MAIL_AGENT_ERROR_MESSAGES;

export class MailAgentError extends Error {
  readonly code: MailAgentErrorCode;
  constructor(code: MailAgentErrorCode) {
    super(MAIL_AGENT_ERROR_MESSAGES[code]);
    this.name = "MailAgentError";
    this.code = code;
  }
}

export function isMailAgentError(value: unknown): value is MailAgentError {
  return value instanceof MailAgentError;
}

/** Reduces anything caught to a `MailAgentError`; provider failures become `provider_failed`. */
export function toMailAgentError(value: unknown, fallback: MailAgentErrorCode = "provider_failed"): MailAgentError {
  if (value instanceof MailAgentError) return value;
  if (fallback === "provider_failed" && toMailError(value).code === "not_connected") return new MailAgentError("no_account");
  return new MailAgentError(fallback);
}

/** Owner-facing text for anything caught. */
export function agentErrorMessage(value: unknown, fallback: MailAgentErrorCode = "provider_failed"): string {
  return toMailAgentError(value, fallback).message;
}

/** Logs only the error name; mailbox and bridge errors can carry account details. */
export type AgentLogger = (event: string, error?: unknown) => void;

export const defaultAgentLogger: AgentLogger = (event, error) => {
  const name = error instanceof Error ? error.name : error === undefined ? "" : typeof error;
  console.warn(`[mail-agent] ${event}${name ? ` (${name})` : ""}`);
};

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MailAgentError("cancelled");
}
