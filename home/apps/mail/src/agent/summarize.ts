/**
 * Thread summaries: a short summary, key points and open asks, plus the
 * thread's attachment names (taken from the thread itself, not the model).
 */
import type { ThreadKey } from "../model/ids";
import { generateJson, type Validator } from "./ai";
import { loadThread, type MailAgentContext } from "./context";
import { buildPrompt } from "./prompt";
import { threadAttachmentNames, threadBlocks } from "./thread-blocks";
import { oneLineText } from "./untrusted";
import type { MailAccount, MailThread } from "../../../_shared/office-accounts/types/mail";

export interface ThreadDigest {
  threadKey: ThreadKey;
  subject: string;
  summary: string;
  keyPoints: string[];
  /** Things someone asked for, especially of the owner. */
  actionItems: string[];
  /** Listed attachment names in the thread. */
  attachments: string[];
  messageCount: number;
}

export const SUMMARY_SCHEMA = '{"summary": string /* at most 3 sentences */, "keyPoints": string[] /* at most 6 */, "actionItems": string[] /* asks still open, say who must act; at most 6 */}';

const MAX_SUMMARY_CHARS = 800;
const MAX_POINT_CHARS = 240;
const MAX_POINTS = 6;

function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => oneLineText(item, MAX_POINT_CHARS)).filter(Boolean).slice(0, MAX_POINTS);
}

export const validateSummary: Validator<{ summary: string; keyPoints: string[]; actionItems: string[] }> = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string") return null;
  const summary = oneLineText(record.summary, MAX_SUMMARY_CHARS);
  if (!summary) return null;
  return { summary, keyPoints: lines(record.keyPoints), actionItems: lines(record.actionItems) };
};

export function buildSummaryPrompt(thread: MailThread, owner: MailAccount): string {
  const attachments = threadAttachmentNames(thread);
  return buildPrompt({
    task: "Summarise the email conversation below for the mailbox owner.",
    schema: SUMMARY_SCHEMA,
    rules: [
      "Mention attachments by name when they matter to the conversation.",
      "Write in the language the conversation is mostly in.",
    ],
    context: `The conversation has ${thread.messages.length} message(s) and ${attachments.length} attachment(s); the attachment names are in the blocks.`,
    blocks: threadBlocks(thread, owner),
  });
}

export async function summarizeThread(ctx: MailAgentContext, key: ThreadKey, options: { signal?: AbortSignal } = {}): Promise<ThreadDigest> {
  const { thread, account } = await loadThread(ctx, key);
  const result = await generateJson(ctx.ai, buildSummaryPrompt(thread, account), validateSummary, SUMMARY_SCHEMA, options);
  return {
    threadKey: key,
    subject: oneLineText(thread.subject, 200),
    ...result,
    attachments: threadAttachmentNames(thread),
    messageCount: thread.messages.filter((message) => !message.draftId).length,
  };
}
