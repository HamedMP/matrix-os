/**
 * The edit flow: an owner instruction becomes tracked changes.
 *
 * 1. Read the document and plan the prompt contexts (whole, focused or parts).
 * 2. For each context: ask the model, parse the JSON envelope, validate every
 *    edit against the live document. When the answer cannot be parsed or an
 *    edit is dropped, ask once more with the problems listed.
 * 3. When any part's answer still cannot be read, apply nothing.
 * 4. Validate all edits together once more (the owner may have typed while
 *    the model worked), turn them into engine operations and apply them in
 *    one session call: tracked, by the assistant, one undo step.
 */

import { ASSISTANT_AUTHOR, MAX_INSTRUCTION_CHARS, MESSAGES, RETRY_RESERVE_CHARS } from "./constants";
import { planContexts } from "./context";
import type { PromptContext } from "./context";
import type { DocumentText } from "./description";
import { readDocument } from "./description";
import { parseAgentEdits, toDocxOps } from "./engine";
import type { AgentDocxEdit, BlockId, DocxDocument, TextRange } from "./engine";
import { callModel, defaultLog, documentToken, promptBudget } from "./model";
import { buildEditPrompt } from "./prompt";
import { summariseChanges, summariseComments } from "./summary";
import type { AgentProgress, AssistantDeps, DroppedEdit, EditRequest, EditRunResult, RelocatedEdit } from "./types";
import { validateEdits } from "./validate";
import type { ValidationResult } from "./validate";

const MAX_SUMMARY_CHARS = 600;

interface Collected {
  edit: AgentDocxEdit;
  chunk: number;
  index: number;
  /** Blocks of the part this edit came from: the only blocks it may land in. */
  scope: ReadonlySet<BlockId>;
}

/** Blocks a selection touches, in document order. */
export function selectionBlocks(text: DocumentText, selection: TextRange | null | undefined): BlockId[] {
  if (selection === null || selection === undefined) return [];
  const start = text.byId.get(selection.start.blockId);
  const end = text.byId.get(selection.end.blockId);
  if (start === undefined || end === undefined) return [start?.id, end?.id].filter((id): id is BlockId => id !== undefined);
  const [from, to] = start.order <= end.order ? [start.order, end.order] : [end.order, start.order];
  return text.blocks.slice(from, to + 1).map((block) => block.id);
}

/** The selected text in the `final` view, or null for no selection or one that no longer resolves. */
export function selectionText(doc: DocxDocument, selection: TextRange | null | undefined, log: AssistantDeps["log"]): string | null {
  if (selection === null || selection === undefined) return null;
  const { start, end } = selection;
  if (start.blockId === end.blockId && start.offset === end.offset) return null;
  try {
    return doc.getPlainText({ range: selection, view: "final" });
  } catch (error) {
    (log ?? defaultLog)("docs assistant: the selection no longer resolves", error);
    return null;
  }
}

function problemsOf(result: ValidationResult): string[] {
  return result.dropped.map((entry) => entry.message);
}

export async function runAssistantEdit(deps: AssistantDeps, request: EditRequest): Promise<EditRunResult> {
  const { session } = deps;
  const doc = session.document;
  if (doc === null) return { status: "failed", reason: "no_document", message: MESSAGES.no_document };
  const instruction = request.instruction.trim();
  if (instruction === "") return { status: "failed", reason: "empty_instruction", message: MESSAGES.empty_instruction };
  if (instruction.length > MAX_INSTRUCTION_CHARS) return { status: "failed", reason: "instruction_too_long", message: MESSAGES.instruction_too_long };

  const mode = request.mode ?? "edit";
  const author = deps.author ?? ASSISTANT_AUTHOR;
  const token = documentToken(session);
  const progress = (update: AgentProgress) => {
    try {
      request.onProgress?.(update);
    } catch (error) {
      (deps.log ?? defaultLog)("docs assistant: a progress listener failed", error);
    }
  };

  progress({ phase: "reading", chunk: 0, chunks: 0, message: "Reading the document" });
  const text = readDocument(doc);
  const selected = selectionText(doc, request.selection, deps.log);
  const base = { mode, instruction, selectionText: selected } as const;
  // The prompt without document text, with the longest part counters, is the fixed cost.
  const fixed = buildEditPrompt({ ...base, context: "", part: 99_999, parts: 99_999 }).length;
  const room = promptBudget(deps) - fixed - RETRY_RESERVE_CHARS;
  if (room < 1_000) return { status: "failed", reason: "instruction_too_long", message: MESSAGES.instruction_too_long };

  const plan = planContexts(text, {
    instruction,
    selectionBlockIds: selectionBlocks(text, request.selection),
    scope: request.scope ?? (mode === "comment" ? "document" : "auto"),
    budget: room,
    definedTerms: doc.getDefinedTerms(),
  });
  const chunks = plan.contexts.length;
  const collected: Collected[] = [];
  const summaries: string[] = [];
  const chunkDropped: DroppedEdit[] = [];

  for (const context of plan.contexts) {
    const outcome = await runContext(deps, context, base, token, request.signal, progress);
    if (outcome.status !== "ok") return outcome.result;
    for (let i = 0; i < outcome.validation.edits.length; i++) {
      collected.push({ edit: outcome.validation.edits[i] as AgentDocxEdit, chunk: context.part, index: outcome.validation.indexes[i] as number, scope: context.blockIds });
    }
    chunkDropped.push(...outcome.validation.dropped);
    if (outcome.summary !== null) summaries.push(outcome.summary);
  }

  // All parts together, against the document as it is now.
  const live = session.document;
  if (live === null || documentToken(session) !== token) return { status: "failed", reason: "document_changed", message: MESSAGES.document_changed };
  const final = validateEdits({
    doc: live,
    text: readDocument(live),
    edits: collected.map((entry) => entry.edit),
    scope: (position) => (collected[position] as Collected).scope,
    mode,
    chunk: 0,
  });
  const meta = (position: number) => collected[position] as Collected;
  const dropped = [
    ...chunkDropped,
    ...final.dropped.map((entry) => ({ ...entry, chunk: meta(entry.index).chunk, index: meta(entry.index).index })),
  ];
  const relocated: RelocatedEdit[] = final.relocated.map((entry) => ({ ...entry, chunk: meta(entry.index).chunk, index: meta(entry.index).index }));
  const joined = summaries.join(" ").trim();
  const summary = joined === "" ? null : joined.length > MAX_SUMMARY_CHARS ? `${joined.slice(0, MAX_SUMMARY_CHARS - 1)}…` : joined;

  if (final.edits.length === 0) {
    progress({ phase: "done", chunk: chunks, chunks, message: "No changes proposed" });
    return { status: "no_changes", summary, dropped, relocated, chunks, partial: plan.truncated };
  }

  progress({ phase: "applying", chunk: chunks, chunks, message: "Adding the proposed changes" });
  const ops = toDocxOps(live, final.edits).ops;
  let applied;
  try {
    applied = session.apply(ops, { track: true, author, origin: "agent" });
  } catch (error) {
    (deps.log ?? defaultLog)("docs assistant: applying the proposed changes failed", error);
    return { status: "failed", reason: "apply_failed", message: MESSAGES.apply_failed };
  }
  const commentIds = applied.results.map((result) => result.commentId).filter((id): id is string => id !== null);
  progress({ phase: "done", chunk: chunks, chunks, message: "Changes proposed" });
  return {
    status: "applied",
    revisionIds: applied.revisionIds,
    commentIds,
    changes: summariseChanges(live, applied.revisionIds),
    comments: summariseComments(live, commentIds),
    summary,
    dropped,
    relocated,
    chunks,
    partial: plan.truncated,
  };
}

type ContextOutcome =
  | { status: "ok"; validation: ValidationResult; summary: string | null }
  | { status: "stop"; result: EditRunResult };

/** Asks about one context, with one retry. Never applies anything. */
async function runContext(
  deps: AssistantDeps,
  context: PromptContext,
  base: { mode: "edit" | "comment"; instruction: string; selectionText: string | null },
  token: number,
  signal: AbortSignal | undefined,
  progress: (update: AgentProgress) => void,
): Promise<ContextOutcome> {
  const { part, parts } = context;
  const ask = async (problems?: string[]) => {
    const prompt = buildEditPrompt({ ...base, context: context.text, part, parts, problems });
    return callModel(deps, prompt, token, signal);
  };
  const stop = (reply: Exclude<Awaited<ReturnType<typeof callModel>>, { ok: true }>): ContextOutcome =>
    reply.status === "cancelled" ? { status: "stop", result: { status: "cancelled" } } : { status: "stop", result: { status: "failed", reason: reply.reason, message: reply.message } };
  const check = (answer: string) => {
    const parsed = parseAgentEdits(answer, "docx");
    if (!parsed.ok || parsed.envelope.kind !== "docx") return { parsed: false as const, problem: parsed.ok ? "the answer is not a docx envelope" : `${parsed.error.message}${parsed.error.path ? ` (at ${parsed.error.path})` : ""}` };
    const doc = deps.session.document as DocxDocument;
    const validation = validateEdits({ doc, text: readDocument(doc), edits: parsed.envelope.edits, scope: context.blockIds, mode: base.mode, chunk: part });
    return { parsed: true as const, validation, summary: parsed.envelope.summary?.trim() || null };
  };

  progress({ phase: "asking", chunk: part, chunks: parts, message: parts > 1 ? `Working on part ${part} of ${parts}` : "Asking the assistant" });
  const first = await ask();
  if (!first.ok) return stop(first);
  progress({ phase: "validating", chunk: part, chunks: parts, message: "Checking the answer against the document" });
  const firstCheck = check(first.text);
  if (firstCheck.parsed && firstCheck.validation.dropped.length === 0) {
    return { status: "ok", validation: firstCheck.validation, summary: firstCheck.summary };
  }

  progress({ phase: "retrying", chunk: part, chunks: parts, message: "Asking the assistant to correct its answer" });
  const problems = firstCheck.parsed ? problemsOf(firstCheck.validation) : [`The answer could not be read: ${firstCheck.problem}.`];
  const second = await ask(problems);
  if (!second.ok) return stop(second);
  const secondCheck = check(second.text);
  if (secondCheck.parsed) return { status: "ok", validation: secondCheck.validation, summary: secondCheck.summary };
  if (firstCheck.parsed) return { status: "ok", validation: firstCheck.validation, summary: firstCheck.summary };
  return { status: "stop", result: { status: "invalid_reply", chunk: part, message: MESSAGES.invalid_reply } };
}
