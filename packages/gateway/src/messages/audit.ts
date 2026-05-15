import type { MessagingNetworkSlug } from "./schemas.js";

export type MessagingAuditActor = "owner" | "hermes" | "automation" | "system" | "operator";
export type MessagingAuditType =
  | "permission_changed"
  | "ai_reply_created"
  | "ai_reply_sent"
  | "account_connected"
  | "account_disconnected"
  | "setup_failed"
  | "recovery_started";

export interface MessagingAuditInput {
  ownerId: string;
  type: MessagingAuditType;
  actor: MessagingAuditActor;
  safeSummary: string;
  networkSlug?: MessagingNetworkSlug;
  roomId?: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
}

const UNSAFE_SUMMARY = /(postgres|sqlite|mysql|token|secret|password|\/home\/|\/tmp\/|stack|constraint|qr|phone|email)/i;

export function sanitizeAuditSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!compact || UNSAFE_SUMMARY.test(compact)) return "Messaging action recorded";
  return compact;
}
