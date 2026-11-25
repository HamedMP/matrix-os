/**
 * Whether a Send click may go ahead, and what to ask first.
 *
 * Sending is only ever started by the owner: `isExplicitSend` accepts a
 * click on Send or the Send keyboard shortcut and nothing else, and the
 * composer never calls `sendDraft` from an effect, a timer or a save.
 * Unresolved tracked changes never go out silently: the owner reviews them,
 * accepts them all, or cancels.
 */
import type { DraftIssue } from "../../../_shared/office-accounts/types/mail";

export interface SendPlanInput {
  /** Pending tracked changes in the body. */
  pendingChanges: number;
  /** Recipient entries that are not usable addresses. */
  invalidRecipients: number;
  /** Valid recipients across To, Cc and Bcc. */
  recipientCount: number;
  /** The store's `draftIssues` for the draft as it would be sent. */
  issues: readonly DraftIssue[];
  sending: boolean;
  /** True while an attachment is still being read. */
  attaching: boolean;
}

export type SendBlock = "busy" | "attaching" | "no_recipients" | "invalid_recipients" | "issues";

export type SendPlan =
  | { kind: "send" }
  | { kind: "review"; pending: number }
  | { kind: "blocked"; reason: SendBlock };

export function planSend(input: SendPlanInput): SendPlan {
  if (input.sending) return { kind: "blocked", reason: "busy" };
  if (input.attaching) return { kind: "blocked", reason: "attaching" };
  if (input.invalidRecipients > 0) return { kind: "blocked", reason: "invalid_recipients" };
  if (input.recipientCount === 0) return { kind: "blocked", reason: "no_recipients" };
  if (input.issues.length > 0) return { kind: "blocked", reason: "issues" };
  if (input.pendingChanges > 0) return { kind: "review", pending: input.pendingChanges };
  return { kind: "send" };
}

export const SEND_BLOCK_TEXT: Readonly<Record<SendBlock, string>> = Object.freeze({
  busy: "This message is already being sent.",
  attaching: "Wait for the attachment to finish.",
  no_recipients: "Add at least one recipient.",
  invalid_recipients: "Fix or remove the addresses marked in red.",
  issues: "This draft cannot be sent yet. Check the notes above.",
});

export function unresolvedWarning(count: number): { title: string; description: string } {
  const noun = count === 1 ? "tracked change" : "tracked changes";
  return {
    title: "Unresolved changes",
    description: `This message has ${count} ${noun} that ${count === 1 ? "is" : "are"} not accepted or rejected. Review them, or accept all and send.`,
  };
}

/** What started a send. Only these two are the owner's explicit action. */
export type SendTrigger = { kind: "click" } | { kind: "shortcut" };

export function isExplicitSend(trigger: SendTrigger | null | undefined): boolean {
  return typeof trigger === "object" && trigger !== null && (trigger.kind === "click" || trigger.kind === "shortcut");
}
