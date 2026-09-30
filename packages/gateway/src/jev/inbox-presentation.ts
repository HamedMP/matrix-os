import { EMAIL_TRIAGE_LABELS, JevInboxGmailIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
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

/** Only a completed broker-owned result enters this formatter. Native tool/model output is never an input. */
export function formatJevInboxPresentation(value: unknown): string | null {
  const parsed = Presentation.safeParse(value);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (result.kind === "review") return "Review — context is unverified. No labels or archives are applied. No mailbox changes have been made.";
  if (result.kind === "labeling_unconfirmed") return ["Mailbox labeling could not be confirmed", `Thread: ${result.threadId}`,
    `Requested labels: ${result.labels.join(", ")}`, "Some labels may have been added. Check Gmail before retrying. No archive, send or delete was requested."].join("\n");
  if (result.kind === "labeled") return ["Inbox labeling complete", `Thread: ${result.threadId}`,
    `Verified snapshot: ${result.messageCount} messages, observed ${result.observedAt}`,
    result.labels.length ? `Confirmed in Gmail: ${result.labels.join(", ")} on ${result.messageCount} messages.` : "No eligible labels; no mailbox changes were needed.",
    "Existing labels were preserved. No messages were archived, sent or deleted."].join("\n");
  return [result.labelingSkipped === "review_required" ? "Review required before labeling" : "Read-only Inbox triage proposal", `Thread: ${result.threadId}`,
    `Verified snapshot: ${result.messageCount} messages, observed ${result.observedAt}`,
    `Proposed labels: ${result.labels.join(", ") || "None"}`,
    `Archive proposal: ${result.archiveProposal ? "Remove INBOX only" : "None"}`,
    ...(result.labelingSkipped === "review_required" ? ["Labeling permission is enabled, but the classification requires review. No labels were added."] : []),
    "No mailbox changes have been made."].join("\n");
}
