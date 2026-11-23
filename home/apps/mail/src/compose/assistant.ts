/**
 * The assistant inside the composer: write or rewrite the body. The result
 * is never put into the draft directly; the composer shows it as tracked
 * changes against the current text for the owner to review.
 */
import { textToHtml } from "../../../_shared/office-accounts/mail/text";
import { generateJson, type GenerateOptions, type MailAi } from "../agent/ai";
import { validateReplyText } from "../agent/drafting";
import { MAX_INSTRUCTION_CHARS } from "../agent/limits";
import { buildPrompt, type PromptBlock } from "../agent/prompt";
import type { DraftKind } from "../model";

export const ASSISTANT_AUTHOR = "Assistant";
export const REWRITE_SCHEMA = '{"body": string /* plain text of the whole message body: greeting, message, sign-off; no subject line, no quoted original */}';
const MAX_BODY_BLOCK_CHARS = 16_000;
const MAX_QUOTE_BLOCK_CHARS = 8_000;

export interface RewriteInput {
  kind: DraftKind;
  subject: string;
  /** The owner's current text, accepted changes applied. Empty for a fresh draft. */
  bodyText: string;
  /** The quoted original of a reply or forward, as text. */
  quoteText: string | null;
  /** What the owner asked for, e.g. "shorter and warmer". */
  instruction: string;
}

export function buildRewritePrompt(input: RewriteInput): string {
  const writing = !input.bodyText.trim();
  const blocks: PromptBlock[] = [];
  if (!writing) blocks.push({ label: "The owner's current draft", subject: input.subject, text: input.bodyText.slice(0, MAX_BODY_BLOCK_CHARS) });
  if (input.quoteText) blocks.push({ label: input.kind === "forward" ? "Message being forwarded" : "Message being answered", text: input.quoteText.slice(0, MAX_QUOTE_BLOCK_CHARS) });
  return buildPrompt({
    task: writing
      ? "Write the body of the owner's email, following the owner instruction."
      : "Rewrite the owner's current draft as the owner instruction asks. Keep everything the instruction does not ask to change.",
    schema: REWRITE_SCHEMA,
    rules: [
      "Keep the owner's language. Keep names, dates, amounts and links exactly as they are.",
      "Keep the signature lines after a line that is only \"-- \" unchanged.",
      "Leave a clear placeholder like [date] for any fact you do not know instead of guessing.",
    ],
    context: input.subject ? `Subject of the email: ${input.subject.replace(/\s+/g, " ").slice(0, 255)}` : undefined,
    instruction: (input.instruction.trim() || (writing ? "Write a short, friendly reply." : "Improve clarity and tone.")).slice(0, MAX_INSTRUCTION_CHARS),
    blocks,
  });
}

/** Composer HTML for plain text: one block per line, blank lines kept. */
export function textToBodyHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<div>${line ? textToHtml(line).replace(/&#39;/g, "'") : "<br>"}</div>`)
    .join("");
}

/** Asks the model for the new body. Rejects with `MailAgentError`. */
export async function assistantBodyHtml(ai: MailAi, input: RewriteInput, options: GenerateOptions = {}): Promise<string> {
  const reply = await generateJson(ai, buildRewritePrompt(input), validateReplyText, REWRITE_SCHEMA, options);
  return textToBodyHtml(reply.body);
}
