/**
 * Prompt text of the Docs assistant. Every prompt states the untrusted-text
 * rule first, keeps the owner's own words outside the external-content
 * markers, and puts document text only inside them.
 */

import { MAX_RETRY_PROBLEMS, MAX_RETRY_PROBLEM_CHARS, MAX_SELECTION_CHARS } from "./constants";
import { agentEditInstructions } from "./engine";
import { UNTRUSTED_RULE, wrapUntrusted } from "./untrusted";

const ROLE = "You are Matrix Assistant, working on a word-processing document for its owner in Matrix OS.";

export type EditPromptMode = "edit" | "comment";

export interface EditPromptInput {
  mode: EditPromptMode;
  instruction: string;
  /** Selected text, or null. Cut to {@link MAX_SELECTION_CHARS}. */
  selectionText: string | null;
  /** The wrapped document context (`PromptContext.text`), or "" when measuring. */
  context: string;
  /** Part number and count of the context. */
  part: number;
  parts: number;
  /** Problems of the previous answer, for the retry. */
  problems?: readonly string[];
}

function selectionSection(selectionText: string | null): string {
  if (selectionText === null || selectionText.trim() === "") return "";
  const cut = selectionText.length > MAX_SELECTION_CHARS ? `${selectionText.slice(0, MAX_SELECTION_CHARS - 1)}…` : selectionText;
  return `\n# Selection\nThe owner selected this text. Unless the instruction says otherwise, it is what the instruction is about.\n${wrapUntrusted("selection", cut)}\n`;
}

function problemsSection(problems: readonly string[] | undefined): string {
  if (problems === undefined || problems.length === 0) return "";
  const shown = problems.slice(0, MAX_RETRY_PROBLEMS).map((problem) => {
    const line = problem.replace(/\s+/g, " ");
    return `- ${line.length > MAX_RETRY_PROBLEM_CHARS ? `${line.slice(0, MAX_RETRY_PROBLEM_CHARS - 1)}…` : line}`;
  });
  const more = problems.length > MAX_RETRY_PROBLEMS ? `\n- … ${problems.length - MAX_RETRY_PROBLEMS} more problems` : "";
  return `\n# Problems with your previous answer\nYour previous answer could not be used as it was. Fix these problems and return the complete corrected JSON object:\n${shown.join("\n")}${more}\n`;
}

function taskLines(mode: EditPromptMode, part: number, parts: number): string[] {
  const lines =
    mode === "comment"
      ? [
          "Review the document against the owner's instructions below. Add a comment wherever the draft deviates from them, saying briefly what deviates and why.",
          'Use only "comment" edits. Do not change, insert or delete any text. When nothing deviates, return no edits.',
        ]
      : [
          "Carry out the owner's instruction below as edits to the document. Your edits are shown to the owner as tracked changes to accept or reject.",
          "Make only the changes the instruction asks for. When no change is needed, return no edits.",
        ];
  if (parts > 1) lines.push(`The document is long, so you see part ${part} of ${parts}. Edit only paragraphs of this part; other parts are handled separately.`);
  return lines;
}

const OUTPUT_RULES = [
  "# Output rules",
  "- Return only the JSON edit object described below: no prose before or after it, no code fence.",
  "- Reference paragraphs only by the block ids shown in square brackets in the document text, and only ids that were shown.",
  "- Quote existing text exactly as it appears in that paragraph, character for character.",
  '- When nothing needs to change, return {"kind":"docx","edits":[]}.',
].join("\n");

/** The prompt for edits or comment-only review of one context. */
export function buildEditPrompt(input: EditPromptInput): string {
  return [
    ROLE,
    UNTRUSTED_RULE,
    "",
    "# Task",
    ...taskLines(input.mode, input.part, input.parts),
    "",
    input.mode === "comment" ? "# Owner's instructions the draft must follow" : "# Owner's instruction",
    input.instruction,
    selectionSection(input.selectionText),
    OUTPUT_RULES,
    "",
    agentEditInstructions("docx"),
    "",
    "# Document",
    input.context,
    problemsSection(input.problems),
  ].join("\n");
}

export type AnswerPromptKind = "ask" | "explain" | "summarise-part" | "summarise";

export interface AnswerPromptInput {
  kind: AnswerPromptKind;
  /** The owner's question; for `explain` and summaries a fixed request. */
  question: string;
  selectionText: string | null;
  context: string;
  part: number;
  parts: number;
}

const ANSWER_RULES = [
  "# Answer rules",
  "- Answer in plain text for the owner, briefly and precisely. No JSON, no Markdown headings.",
  "- After each statement that relies on the document, cite the paragraph it comes from by its block id in square brackets, for example [b12]. Cite only ids shown in the document text.",
  "- When the document does not answer the question, say so instead of guessing.",
].join("\n");

function answerTask(kind: AnswerPromptKind, part: number, parts: number): string {
  switch (kind) {
    case "explain":
      return "Explain the selected text in plain language: what it means, what it requires of whom, the defined terms and other clauses it relies on, and anything unclear or risky.";
    case "summarise-part":
      return `Summarise part ${part} of ${parts} of the document in at most eight short points.`;
    case "summarise":
      return "Summarise the document: its purpose, the parties, and the main obligations, dates and amounts.";
    default:
      return "Answer the owner's question about the document.";
  }
}

/** The prompt for an answer in text with citations. */
export function buildAnswerPrompt(input: AnswerPromptInput): string {
  return [
    ROLE,
    UNTRUSTED_RULE,
    "",
    "# Task",
    answerTask(input.kind, input.part, input.parts),
    "",
    "# Owner's request",
    input.question,
    selectionSection(input.selectionText),
    ANSWER_RULES,
    "",
    "# Document",
    input.context,
  ].join("\n");
}

/**
 * The prompt that joins the answers for the parts of a long document into
 * one: a summary of the whole, or one answer to the owner's question.
 */
export function buildCombinePrompt(partAnswers: readonly string[], kind: "summary" | "answer", question: string): string {
  const joined = partAnswers.map((answer, index) => `## Part ${index + 1}\n${answer}`).join("\n\n");
  const task =
    kind === "summary"
      ? "These are summaries of the parts of one long document, written from its text. Combine them into one summary of the whole document: its purpose, the parties, and the main obligations, dates and amounts."
      : "These are answers to the owner's request below, each written from one part of a long document. Combine them into one answer; leave out parts that say they do not answer it.";
  return [
    ROLE,
    UNTRUSTED_RULE,
    "",
    "# Task",
    `${task} Keep the block id citations in square brackets.`,
    "",
    "# Owner's request",
    question,
    "",
    ANSWER_RULES,
    "",
    "# Part answers",
    wrapUntrusted("part answers", joined),
  ].join("\n");
}
