export type EditionView = "library" | "latest" | "unread" | "saved" | "review";
export type EditionScope = "all" | "personal" | "work";
export interface EditionSource {
  id: string;
  connectionId: string;
  email: string;
  label: string;
  scope: "personal" | "work";
  state: string;
  coverageStart?: string;
  lastSyncedAt?: string;
  coverageEnd?: string;
  availability?: "connected" | "disconnected" | "unknown";
  syncError?: "sync_unavailable";
  failureAt?: string;
  usedBytes?: number;
  quotaBytes?: number;
  retainedCount?: number;
  classifiedCount?: number;
  reviewPendingCount?: number;
  partialCount?: number;
  observedScope?: "account_total";
  observed?: {
    connectorCalls: number;
    messageRetrievals: number;
    reusedBodies: number;
    aiClassificationCalls: number;
    classificationReuse: number;
  };
  billedUsage?: null;
  sharedWith?: ("folio" | "atlas")[];
}
export interface EditionMessage {
  id: string;
  sourceId: string;
  subject: string;
  sender: string;
  publication: string;
  receivedAt: string;
  excerpt: string;
  text?: string;
  contentVersion: string;
  partial?: boolean;
  classification: "newsletter" | "review" | "other";
  saved: boolean;
  read: boolean;
  progress: number;
  revision: number;
  readingRevision: number;
}
export interface ReadingPatch {
  id: string;
  baseRevision: number;
  saved?: boolean;
  read?: boolean;
  progress?: number;
}
export interface CleanupPlan {
  id: string;
  revision: number;
  messageIds: string[];
  expiresAt: string;
}
export interface CleanupReceipt {
  id: string;
  state: "completed" | "undone" | "partial" | "needs_verification";
  archivedCount?: number;
  restoredCount?: number;
}
export interface CleanupOperation {
  plan: CleanupPlan;
  receipt: CleanupReceipt;
}
export type MailAction =
  | "sources"
  | "connect"
  | "sync"
  | "retention"
  | "messages"
  | "message"
  | "reading"
  | "correct"
  | "cleanup-recovery"
  | "cleanup-preview"
  | "cleanup-commit"
  | "cleanup-undo"
  | "export"
  | "delete";
export type MailBridge = (
  action: MailAction,
  payload?: Record<string, unknown>,
) => Promise<unknown>;
