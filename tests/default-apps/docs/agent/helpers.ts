/**
 * Helpers for the Docs assistant tests: a session on a real fixture and a
 * scripted model that records every prompt it receives.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import type { DocxDocument, NewParagraph } from "../../../../home/apps/_shared/office-engine/index";
import { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { createFakeFiles } from "../session/fakes";

export const FIXTURES = resolve(__dirname, "../../../office/fixtures");

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

export const OWNER = "Rae Okafor";

export async function contractSession(extra: Record<string, Uint8Array> = {}): Promise<{ session: DocumentSession; files: ReturnType<typeof createFakeFiles> }> {
  const files = createFakeFiles({ "Documents/contract.docx": fixture("contract.docx"), ...extra });
  const session = new DocumentSession({ files, author: OWNER, autosave: false, log: () => undefined });
  const opened = await session.open("Documents/contract.docx");
  if (opened.status !== "opened") throw new Error(`could not open the fixture: ${opened.status}`);
  return { session, files };
}

export async function sessionWith(paragraphs: NewParagraph[]): Promise<DocumentSession> {
  const session = new DocumentSession({ files: createFakeFiles(), author: OWNER, autosave: false, log: () => undefined });
  await session.adopt(createDocx({ paragraphs }), { name: "Test", dirty: false });
  return session;
}

/** A long document: `clauses` headings, each with `perClause` numbered paragraphs of filler text. */
export function longParagraphs(clauses: number, perClause: number): NewParagraph[] {
  const paragraphs: NewParagraph[] = [];
  for (let c = 1; c <= clauses; c++) {
    paragraphs.push({ text: `${c}. Clause heading number ${c}`, style: { headingLevel: 1 } });
    for (let p = 1; p <= perClause; p++) {
      paragraphs.push(`${c}.${p}\tThe party shall perform obligation ${c}-${p} with reasonable care, within ten Business Days, in accordance with the agreed plan for item ${c * 100 + p}.`);
    }
  }
  return paragraphs;
}

export type Reply = string | Error | ((prompt: string) => string);

export interface ScriptedModel {
  generate: (input: { prompt: string }) => Promise<{ text: string }>;
  prompts: string[];
}

/** Answers with the replies in order; the last one repeats. */
export function scripted(...replies: Reply[]): ScriptedModel {
  const prompts: string[] = [];
  return {
    prompts,
    async generate({ prompt }) {
      prompts.push(prompt);
      const reply = replies[Math.min(prompts.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === "function" ? reply(prompt) : (reply ?? "") };
    },
  };
}

export function envelope(edits: unknown[], summary?: string): string {
  return JSON.stringify({ kind: "docx", edits, ...(summary !== undefined ? { summary } : {}) });
}

export function finalText(doc: DocxDocument): string {
  return doc.getPlainText({ view: "final" });
}

/** Block ids shown in the document part of a prompt. */
export function shownIds(prompt: string): string[] {
  return [...prompt.matchAll(/^\[([^\]\s]+)\]/gm)].map((match) => match[1] as string);
}
