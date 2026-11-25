/**
 * Answers in text: questions about the document, an explanation of the
 * selection, and a summary. Answers cite paragraphs as `[b12]`; citations of
 * blocks the model was shown become clickable segments, anything else stays
 * plain text. Nothing here changes the document.
 */

import { selectionBlocks, selectionText } from "./assistant";
import { MAX_INSTRUCTION_CHARS, MESSAGES } from "./constants";
import { planContexts } from "./context";
import type { PromptContext } from "./context";
import { readDocument } from "./description";
import type { BlockId, TextRange } from "./engine";
import { callModel, documentToken, promptBudget } from "./model";
import type { ModelReply } from "./model";
import { buildAnswerPrompt, buildCombinePrompt } from "./prompt";
import type { AnswerPromptKind } from "./prompt";
import type { AgentProgress, AnswerResult, AnswerSegment, AssistantDeps } from "./types";

const CITATION = /\[([^[\]\n]{1,200})\]/g;

/**
 * Splits an answer into text and citations. A bracket that names one or more
 * valid block ids (`[b12]`, `[b12, b14]`) becomes citations, numbered by
 * first appearance; any other bracket stays text.
 */
export function parseCitations(text: string, validIds: ReadonlySet<BlockId>): { segments: AnswerSegment[]; citedBlockIds: BlockId[] } {
  const segments: AnswerSegment[] = [];
  const numbers = new Map<BlockId, number>();
  let last = 0;
  const pushText = (value: string) => {
    if (value === "") return;
    const previous = segments[segments.length - 1];
    if (previous?.type === "text") previous.text += value;
    else segments.push({ type: "text", text: value });
  };
  for (const match of text.matchAll(CITATION)) {
    const ids = (match[1] as string).split(/[\s,;]+/).filter((token) => token !== "");
    if (ids.length === 0 || !ids.every((id) => validIds.has(id))) continue;
    pushText(text.slice(last, match.index));
    for (const id of ids) {
      if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
      segments.push({ type: "citation", blockId: id, number: numbers.get(id) as number });
    }
    last = (match.index as number) + match[0].length;
  }
  pushText(text.slice(last));
  return { segments, citedBlockIds: [...numbers.keys()] };
}

export interface AskRequest {
  question: string;
  selection?: TextRange | null;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
}

function failed(reply: Exclude<ModelReply, { ok: true }>): AnswerResult {
  return reply.status === "cancelled" ? { status: "cancelled" } : { status: "failed", reason: reply.reason, message: reply.message };
}

/** Answers a question about the document, citing the paragraphs it relies on. */
export function askDocument(deps: AssistantDeps, request: AskRequest): Promise<AnswerResult> {
  return answer(deps, "ask", request.question, request, "auto");
}

/** Explains the selected text. */
export function explainSelection(deps: AssistantDeps, request: Omit<AskRequest, "question">): Promise<AnswerResult> {
  return answer(deps, "explain", "Explain the selected text.", request, "selection");
}

/** Summarises the document; a long document is summarised part by part and the parts combined. */
export function summariseDocument(deps: AssistantDeps, request: Omit<AskRequest, "question"> = {}): Promise<AnswerResult> {
  return answer(deps, "summarise", "Summarise this document.", request, "document");
}

async function answer(
  deps: AssistantDeps,
  kind: AnswerPromptKind,
  rawQuestion: string,
  request: Omit<AskRequest, "question">,
  scope: "auto" | "selection" | "document",
): Promise<AnswerResult> {
  const { session } = deps;
  const doc = session.document;
  if (doc === null) return { status: "failed", reason: "no_document", message: MESSAGES.no_document };
  const question = rawQuestion.trim();
  if (question === "") return { status: "failed", reason: "empty_instruction", message: MESSAGES.empty_instruction };
  if (question.length > MAX_INSTRUCTION_CHARS) return { status: "failed", reason: "instruction_too_long", message: MESSAGES.instruction_too_long };
  const selected = selectionText(doc, request.selection, deps.log);
  if (kind === "explain" && selected === null) return { status: "failed", reason: "empty_instruction", message: "Select the text to explain first." };

  const token = documentToken(session);
  const budget = promptBudget(deps);
  const progress = (update: AgentProgress) => request.onProgress?.(update);
  progress({ phase: "reading", chunk: 0, chunks: 0, message: "Reading the document" });
  const text = readDocument(doc);
  const fixed = buildAnswerPrompt({ kind: kind === "summarise" ? "summarise-part" : kind, question, selectionText: selected, context: "", part: 99_999, parts: 99_999 }).length;
  const room = budget - fixed;
  if (room < 1_000) return { status: "failed", reason: "instruction_too_long", message: MESSAGES.instruction_too_long };
  const plan = planContexts(text, {
    instruction: question,
    selectionBlockIds: selectionBlocks(text, request.selection),
    scope,
    budget: room,
    focus: "always",
    definedTerms: doc.getDefinedTerms(),
  });

  const shown = new Set<BlockId>();
  const answers: string[] = [];
  for (const context of plan.contexts) {
    for (const id of context.blockIds) shown.add(id);
    progress({ phase: "asking", chunk: context.part, chunks: context.parts, message: context.parts > 1 ? `Reading part ${context.part} of ${context.parts}` : "Asking the assistant" });
    const reply = await callModel(deps, promptFor(kind, question, selected, context), token, request.signal);
    if (!reply.ok) return failed(reply);
    answers.push(reply.text.trim());
  }

  let final = answers[0] ?? "";
  if (answers.length > 1) {
    progress({ phase: "asking", chunk: plan.contexts.length, chunks: plan.contexts.length, message: "Combining the parts" });
    const empty = buildCombinePrompt(answers.map(() => ""), kind === "summarise" ? "summary" : "answer", question).length;
    const share = Math.max(200, Math.floor((budget - empty) / answers.length) - 1);
    const cut = answers.map((part) => (part.length > share ? `${part.slice(0, share - 1)}…` : part));
    const reply = await callModel(deps, buildCombinePrompt(cut, kind === "summarise" ? "summary" : "answer", question), token, request.signal);
    if (!reply.ok) return failed(reply);
    final = reply.text.trim();
  }
  progress({ phase: "done", chunk: plan.contexts.length, chunks: plan.contexts.length, message: "Answered" });
  const { segments, citedBlockIds } = parseCitations(final, shown);
  return { status: "answered", text: final, segments, citedBlockIds, partial: plan.truncated };
}

function promptFor(kind: AnswerPromptKind, question: string, selected: string | null, context: PromptContext): string {
  const promptKind: AnswerPromptKind = kind === "summarise" && context.parts > 1 ? "summarise-part" : kind;
  return buildAnswerPrompt({ kind: promptKind, question, selectionText: selected, context: context.text, part: context.part, parts: context.parts });
}
