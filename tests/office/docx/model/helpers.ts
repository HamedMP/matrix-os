import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  DocxBlock,
  DocxDocument,
  DocxStory,
  ParagraphBlock,
  TableBlock,
} from "../../../../packages/office/src/api/docx.js";
import { openDocx } from "../../../../packages/office/src/docx/index.js";

export const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures");

export const DOCX_FIXTURES = [
  "basic.docx",
  "comments.docx",
  "contract-v2.docx",
  "contract.docx",
  "footnotes-headers.docx",
  "links-fields.docx",
  "numbering.docx",
  "table.docx",
  "tracked.docx",
  "unicode.docx",
] as const;

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

export function expectedText(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, "expected", name), "utf8");
}

export async function openFixture(name: string): Promise<DocxDocument> {
  return openDocx(loadFixture(name));
}

export function isParagraph(block: DocxBlock): block is ParagraphBlock {
  return block.type === "paragraph";
}

/** Top-level paragraphs of a story, in order. */
export function paragraphsOf(story: DocxStory): ParagraphBlock[] {
  return story.blocks.filter(isParagraph);
}

export function tablesOf(story: DocxStory): TableBlock[] {
  return story.blocks.filter((block): block is TableBlock => block.type === "table");
}

/** The first top-level paragraph whose text starts with `prefix`. */
export function paragraphStarting(story: DocxStory, prefix: string): ParagraphBlock {
  const found = paragraphsOf(story).find((block) => block.text.startsWith(prefix));
  if (found === undefined) throw new Error(`no paragraph starts with ${JSON.stringify(prefix)}`);
  return found;
}
