import { BatchJobId } from "./inbox-batch-store.js";
import { EMAIL_TRIAGE_LABELS, JevInboxGmailIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
const Absent = z.strictObject({ kind: z.literal("batch_absent") });
const Labels = z.enum(Object.values(EMAIL_TRIAGE_LABELS));
const Presentation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("review"), verified: z.literal(false), readonly: z.literal(true),
    labels: z.tuple([z.literal(EMAIL_TRIAGE_LABELS.review)]), archiveProposal: z.null() }),
  z.strictObject({ kind: z.literal("proposal"), verified: z.literal(true), readonly: z.literal(true),
    labelingSkipped: z.enum(["preview_only", "review_required"]).optional(),
    threadId: JevInboxGmailIdSchema, messageCount: z.number().int().min(1).max(4),
    labels: z.array(Labels).max(8), archiveProposal: z.strictObject({ removeLabelIds: z.tuple([z.literal("INBOX")]) }).nullable(),
    observedAt: z.iso.datetime(), requestId: z.string().max(160).regex(/^jev_req_[A-Za-z0-9_-]+$/) }),
  z.strictObject({ kind: z.literal("labeled"), verified: z.literal(true), readonly: z.literal(false),
    threadId: JevInboxGmailIdSchema, messageCount: z.number().int().min(1).max(4), labels: z.array(Labels).max(8),
    observedAt: z.iso.datetime(), requestId: z.string().max(160).regex(/^jev_req_[A-Za-z0-9_-]+$/) }),
  z.strictObject({ kind: z.literal("labeling_unconfirmed"), verified: z.literal(true), readonly: z.literal(false),
    threadId: JevInboxGmailIdSchema, messageCount: z.number().int().min(1).max(4), labels: z.array(Labels).max(8),
    observedAt: z.iso.datetime(), requestId: z.string().max(160).regex(/^jev_req_[A-Za-z0-9_-]+$/) }),
]);
const Batch = z.strictObject({ kind: z.literal("batch"), jobId: BatchJobId, revision: z.number().int().min(1),
  status: z.enum(["ready", "running", "paused", "completed", "completed_with_unconfirmed", "limit_reached"]),
  processed: z.number().int().min(0).max(10000), labeled: z.number().int().min(0).max(10000), noChange: z.number().int().min(0).max(10000).default(0), review: z.number().int().min(0).max(10000),
  preview: z.number().int().min(0).max(10000), unconfirmed: z.number().int().min(0).max(10000), messagesLabeled: z.number().int().min(0).max(40000),
  remainingQueued: z.number().int().min(0).max(30), hasMore: z.boolean(), maxThreads: z.number().int().min(1).max(10000),
  last: z.object({ threadId: JevInboxGmailIdSchema, status: z.enum(["labeled", "no_op", "review", "proposal", "unconfirmed"]) }).nullable()
}).refine(b => b.processed === b.labeled + b.noChange + b.review + b.preview + b.unconfirmed && b.messagesLabeled <= b.labeled * 4);
function formatBatch(value: unknown): string | null {
  const parsed = Batch.safeParse(value);
  if (!parsed.success)
    return null;
  const b = parsed.data;
  return ["Inbox batch progress", `Job: ${b.jobId}`, `State: ${b.status}`, `Examined: ${b.processed} threads`,
    `Confirmed: ${b.labeled} threads / ${b.messagesLabeled} messages`, `No change needed: ${b.noChange}; Review: ${b.review}; Preview: ${b.preview}; Unconfirmed: ${b.unconfirmed}`,
    `Queued: ${b.remainingQueued}; More pages: ${b.hasMore ? "yes" : "no"}; Thread limit: ${b.maxThreads}`,
    ...(b.last ? [`Last thread: ${b.last.threadId} — ${b.last.status}`] : []),
    b.status === "completed" ? "All listed Inbox threads were examined; unverified Review and preview results were not labeled." :
      b.status === "completed_with_unconfirmed" ? "All listed threads were examined, but some outcomes require Gmail verification." :
        b.status === "limit_reached" ? "Requested thread limit reached. The whole Inbox was not completed." :
          b.status === "paused" ? "Resume this saved job to continue unprocessed threads. Unconfirmed attempts will not be replayed." : "Continue the saved batch; the whole Inbox is not complete yet.",
    "Existing labels are preserved. No archive, send, delete or mark-read is permitted."].join("\n");
}
/** Only a completed broker-owned result enters this formatter. Native tool/model output is never an input. */
export function formatJevInboxPresentation(value: unknown): string | null {
  if (Absent.safeParse(value).success)
    return "No saved Inbox batch. Start a new batch when requested. No mailbox changes have been made.";
  if (value && typeof value === "object" && "kind" in value && value.kind === "batch")
    return formatBatch(value);
  const parsed = Presentation.safeParse(value);
  if (!parsed.success)
    return null;
  const result = parsed.data;
  if (result.kind === "review")
    return "Review — context is unverified. No labels or archives are applied. No mailbox changes have been made.";
  if (result.kind === "labeling_unconfirmed")
    return ["Mailbox labeling could not be confirmed", `Thread: ${result.threadId}`,
      `Requested labels: ${result.labels.join(", ")}`, "Some labels may have been added. Check Gmail before retrying. No archive, send or delete was requested."].join("\n");
  if (result.kind === "labeled")
    return ["Inbox labeling complete", `Thread: ${result.threadId}`,
      `Verified snapshot: ${result.messageCount} messages, observed ${result.observedAt}`,
      result.labels.length ? `Confirmed in Gmail: ${result.labels.join(", ")} on ${result.messageCount} messages.` : "No eligible labels; no mailbox changes were needed.",
      ...(result.labels.includes(EMAIL_TRIAGE_LABELS.review) ? ["The Review label was added for your inspection."] : []),
      "Existing labels were preserved. No messages were archived, sent or deleted."].join("\n");
  return [result.labelingSkipped === "review_required" ? "Review required before labeling" : "Read-only Inbox triage proposal", `Thread: ${result.threadId}`,
    `Verified snapshot: ${result.messageCount} messages, observed ${result.observedAt}`,
    `Proposed labels: ${result.labels.join(", ") || "None"}`,
    `Archive proposal: ${result.archiveProposal ? "Remove INBOX only" : "None"}`,
    ...(result.labelingSkipped === "review_required" ? ["Labeling permission is enabled, but the classification requires review. No labels were added."] : []),
    "No mailbox changes have been made."].join("\n");
}
/** Compact activity text uses the same validated broker counters as the full receipt. */
export function formatJevInboxActivitySummary(value: unknown): string | null {
  if (Absent.safeParse(value).success)
    return "No saved Inbox batch";
  const parsed = Batch.safeParse(value);
  if (!parsed.success)
    return null;
  const b = parsed.data;
  return `Inbox batch: ${b.processed} examined, ${b.labeled} confirmed, ${b.noChange} no change, ${b.review} Review, ${b.unconfirmed} unconfirmed (${b.status})`;
}
