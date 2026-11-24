import { describe, expect, it } from "vitest";

import { compareDocxDetailed } from "../../../../packages/office/src/docx/index.js";
import { AUTHOR, OPTIONS, buildDocx, cell, p, r, resolvedText, row, tbl } from "./helpers.js";

/*
 * Random documents and random edits, from a fixed seed. Whatever the edits,
 * the comparison must pass its own check, and an independent reading of the
 * written file must give the revised text when every change is accepted and
 * the original text when every change is rejected.
 */

interface Run {
  text: string;
  bold: boolean;
}
interface Paragraph {
  kind: "p";
  runs: Run[];
  centred: boolean;
}
interface Table {
  kind: "t";
  rows: Paragraph[][][];
}
type Block = Paragraph | Table;

const WORDS = (
  "the supplier shall deliver services under this agreement within thirty days of notice and the customer pays " +
  "charges monthly unless a party terminates for breach liability is capped insurance cover applies data remains " +
  "confidential clause seven governs disputes London courts decide renewal price review audit report schedule"
).split(" ");

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

class Maker {
  constructor(private readonly random: () => number) {}

  int(limit: number): number {
    return Math.floor(this.random() * limit);
  }

  chance(probability: number): boolean {
    return this.random() < probability;
  }

  words(count: number): string {
    return Array.from({ length: count }, () => WORDS[this.int(WORDS.length)]).join(" ");
  }

  paragraph(): Paragraph {
    if (this.chance(0.08)) return { kind: "p", runs: [], centred: false };
    const runs: Run[] = [];
    const count = 1 + this.int(3);
    for (let index = 0; index < count; index++) {
      runs.push({ text: this.words(2 + this.int(7)) + (index < count - 1 ? " " : "."), bold: this.chance(0.2) });
    }
    return { kind: "p", runs, centred: this.chance(0.1) };
  }

  table(): Table {
    const columns = 1 + this.int(2);
    return {
      kind: "t",
      rows: Array.from({ length: 1 + this.int(3) }, () =>
        Array.from({ length: columns }, () => Array.from({ length: 1 + this.int(2) }, () => this.paragraph())),
      ),
    };
  }

  document(): Block[] {
    const blocks: Block[] = [];
    const count = 1 + this.int(8);
    for (let index = 0; index < count; index++) blocks.push(this.chance(0.2) ? this.table() : this.paragraph());
    return blocks;
  }

  /** Every list of paragraphs in the document: the body's blocks and each cell. */
  private paragraphLists(blocks: Block[]): Paragraph[][] {
    const lists: Paragraph[][] = [];
    for (const block of blocks) {
      if (block.kind === "t") for (const cells of block.rows) for (const paragraphs of cells) lists.push(paragraphs);
    }
    return lists;
  }

  private editText(paragraph: Paragraph): void {
    const run = paragraph.runs[this.int(paragraph.runs.length)];
    if (run === undefined) {
      paragraph.runs.push({ text: `${this.words(3)}.`, bold: false });
      return;
    }
    const words = run.text.split(" ");
    const at = this.int(words.length);
    const choice = this.int(3);
    if (choice === 0) words.splice(at, 1, this.words(1 + this.int(2)));
    else if (choice === 1) words.splice(at, 0, this.words(1 + this.int(3)));
    else if (words.length > 1) words.splice(at, 1);
    run.text = words.join(" ");
  }

  mutate(blocks: Block[]): void {
    const tables = blocks.filter((block): block is Table => block.kind === "t");
    const top = blocks.filter((block): block is Paragraph => block.kind === "p");
    const cellLists = this.paragraphLists(blocks);
    const anyParagraph = (): Paragraph | undefined => {
      const all = [...top, ...cellLists.flat()];
      return all[this.int(all.length)];
    };
    const table = tables[this.int(tables.length)];
    const action = this.int(14);
    if (action <= 2) {
      const paragraph = anyParagraph();
      if (paragraph !== undefined) this.editText(paragraph);
    } else if (action === 3) {
      blocks.splice(this.int(blocks.length + 1), 0, this.paragraph());
    } else if (action === 4 && blocks.length > 1) {
      blocks.splice(this.int(blocks.length), 1);
    } else if (action === 5 && blocks.length > 1) {
      const [moved] = blocks.splice(this.int(blocks.length), 1);
      if (moved !== undefined) blocks.splice(this.int(blocks.length + 1), 0, moved);
    } else if (action === 6) {
      const at = blocks.findIndex((block) => block.kind === "p" && block.runs.length > 1);
      const paragraph = blocks[at];
      if (paragraph !== undefined && paragraph.kind === "p") {
        const cut = 1 + this.int(paragraph.runs.length - 1);
        const second: Paragraph = { kind: "p", runs: paragraph.runs.splice(cut), centred: paragraph.centred };
        blocks.splice(at + 1, 0, second);
      }
    } else if (action === 7) {
      const at = this.int(blocks.length - 1);
      const first = blocks[at];
      const second = blocks[at + 1];
      if (first?.kind === "p" && second?.kind === "p") {
        first.runs.push(...second.runs);
        blocks.splice(at + 1, 1);
      }
    } else if (action === 8) {
      const paragraph = anyParagraph();
      const run = paragraph?.runs[this.int(paragraph.runs.length)];
      if (run !== undefined) run.bold = !run.bold;
      else if (paragraph !== undefined) paragraph.centred = !paragraph.centred;
    } else if (action === 9 && table !== undefined) {
      const columns = table.rows[0]?.length ?? 1;
      table.rows.splice(this.int(table.rows.length + 1), 0, Array.from({ length: columns }, () => [this.paragraph()]));
    } else if (action === 10 && table !== undefined && table.rows.length > 1) {
      table.rows.splice(this.int(table.rows.length), 1);
    } else if (action === 11) {
      const list = cellLists[this.int(cellLists.length)];
      if (list !== undefined) {
        if (list.length > 1 && this.chance(0.5)) list.splice(this.int(list.length), 1);
        else list.splice(this.int(list.length + 1), 0, this.paragraph());
      }
    } else if (action === 12) {
      blocks.splice(this.int(blocks.length + 1), 0, this.table());
    } else if (action === 13) {
      const at = this.int(blocks.length);
      blocks.splice(at, 1, this.paragraph());
    }
  }
}

function paragraphXml(paragraph: Paragraph): string {
  const runs = paragraph.runs.map((run) => r(run.text, run.bold ? "<w:b/>" : "")).join("");
  return p(runs, paragraph.centred ? `<w:jc w:val="center"/>` : "");
}

function documentXml(blocks: Block[]): string {
  return blocks
    .map((block) =>
      block.kind === "p"
        ? paragraphXml(block)
        : tbl(...block.rows.map((cells) => row(...cells.map((paragraphs) => cell(paragraphs.map(paragraphXml).join("")))))),
    )
    .join("");
}

describe("random documents and edits", () => {
  it.each([1, 2, 3, 4, 5, 6])("accepts to the revised text and rejects to the original text (seed %i)", async (seed) => {
    const maker = new Maker(generator(seed * 7919));
    for (let round = 0; round < 60; round++) {
      const blocks = maker.document();
      const originalXml = documentXml(blocks);
      const edited: Block[] = JSON.parse(JSON.stringify(blocks));
      const edits = 1 + maker.int(4);
      for (let index = 0; index < edits; index++) maker.mutate(edited);
      const revisedXml = documentXml(edited);
      const original = await buildDocx({ body: originalXml });
      const revised = await buildDocx({ body: revisedXml });
      const label = `seed ${seed} round ${round}\n${originalXml}\n${revisedXml}`;
      const { document, summary } = await compareDocxDetailed(original, revised, OPTIONS).catch((error: unknown) => {
        throw new Error(`${label}\n${String(error)} ${JSON.stringify((error as { details?: unknown }).details)}`);
      });
      const written = await document.save();
      expect(await resolvedText(written, "accept"), label).toBe(await resolvedText(revised, "accept"));
      expect(await resolvedText(written, "reject"), label).toBe(await resolvedText(original, "accept"));
      expect(summary.changes.every((change) => document.listRevisions().some((revision) => revision.id === change.revisionId))).toBe(true);
      expect(document.listRevisions().every((revision) => revision.author === AUTHOR)).toBe(true);
      expect(summary.identical).toBe(originalXml === revisedXml);
    }
  });
});
