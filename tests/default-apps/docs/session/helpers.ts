import type { DocxDocument, ParagraphBlock } from "../../../../home/apps/_shared/office-engine/index";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { DocumentSession, type DocumentSessionOptions } from "../../../../home/apps/docs/src/session/index";
import { type FakeFiles, createFakeFiles } from "./fakes";

export const OWNER = "Rae Okafor";
export const FIXED_NOW = new Date("2026-11-23T10:15:42.123Z");

export async function docxBytes(paragraphs: string[]): Promise<Uint8Array> {
  return createDocx({ paragraphs }).save();
}

export function paragraphs(doc: DocxDocument): ParagraphBlock[] {
  return doc.getView().body.blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");
}

export function bodyText(doc: DocxDocument, view: "final" | "original" | "markup" = "final"): string {
  return doc.getPlainText({ view });
}

export interface SessionHarness {
  session: DocumentSession;
  files: FakeFiles;
  clock: { now: Date };
}

export async function harness(
  initial: Record<string, string[]> = { "Documents/plan.docx": ["Hello world", "Second paragraph"] },
  options: Partial<DocumentSessionOptions> = {},
): Promise<SessionHarness> {
  const seeded: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(initial)) seeded[path] = await docxBytes(text);
  const files = createFakeFiles(seeded);
  const clock = { now: new Date(FIXED_NOW) };
  const session = new DocumentSession({ files, author: OWNER, now: () => clock.now, autosave: false, ...options });
  return { session, files, clock };
}

/** The first body paragraph id of the open document. */
export function firstId(session: DocumentSession): string {
  return paragraphs(session.requireDocument())[0]!.id;
}
