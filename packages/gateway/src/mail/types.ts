import type { JevEmailTriageResult } from "@matrix-os/contracts";
export interface MailSourceKey { ownerId: string; accountId: string }
export interface MailConsumerScope extends MailSourceKey { appId: string }
export interface MailObject { namespace: string; digest: string; sizeBytes: number }
export interface MailSource extends MailSourceKey {
  provider: "gmail"; connectionId: string; email: string; accountLabel: string;
  group: "work" | "personal"; namespace: string; quotaBytes: number; usedBytes: number;
  cursor: string | null; revision: number; paused?: boolean;
}
export interface MailSourceInput extends MailSourceKey {
  provider: "gmail"; connectionId: string; email: string; group: "work" | "personal";
  accountLabel?: string; quotaBytes?: number;
}
export interface MailMessageInput extends MailSourceKey {
  messageId: string; threadId: string; subject: string; sender: string;
  receivedAt: string; labels: string[]; object: MailObject | null;
  textSnippet?: string; partialReason?: string;
}
export interface ArchivedMessage extends MailMessageInput {
  id: string; revision: number; correction: "newsletter" | "not_newsletter" | null;
  classification: MailClassification | null;
}
export interface MailClassification {
  fingerprint: string; contextKind: "snippet" | "verified"; recipe: "email-triage-v1";
  modelPolicyVersion: string; result: JevEmailTriageResult;
}
export interface MailReadingState {
  saved: boolean; read: boolean; progress: number; revision: number;
}
export interface MailSyncJob extends MailSourceKey {
  id: string; rangeFrom: string; rangeUntil: string; status: "pending" | "running" | "completed";
  token: string | null; leaseUntil: string | null; workerId: string | null;
  checkpoint: Record<string, unknown> | null;
}
export type CleanupStatus = "intent" | "unknown" | "confirmed" | "undone" | "failed" | "planned" | "dispatching" | "skipped" | "undo_pending";
export interface StoredCleanupMessage { messageId: string; contentDigest: string; ready: boolean; category: string; revision: number; policyVersion: string }
export interface StoredCleanupPlan extends MailSourceKey {
  id: string; binding: string; hash: string; expiresAt: number; policyVersion: string; messages: StoredCleanupMessage[];
}
export interface StoredCleanupEntry { messageId: string; state: "planned" | "dispatching" | "unknown" | "confirmed" | "skipped" | "undo_pending" | "undone"; originalInbox?: boolean; labels?: string[] }
export interface StoredCleanupOperation { id: string; plan: StoredCleanupPlan; entries: StoredCleanupEntry[] }
export class MailArchiveError extends Error {
  constructor(readonly code: "denied" | "quota" | "conflict" | "integrity" | "invalid" | "missing", message = "Email archive operation unavailable") { super(message); this.name = "MailArchiveError"; }
}

/** Only verified object-file corruption is eligible for controlled source refetch. */
export class MailContentIntegrityError extends MailArchiveError {
  constructor(){super("integrity");this.name="MailContentIntegrityError";}
}
