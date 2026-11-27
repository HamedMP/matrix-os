import { describe, expect, it } from "vitest";

import type { DocxBlock, DocxStory, InlineRun, ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import { getDocxIndex } from "../../../../packages/office/src/docx/internal.js";
import { DOCX_FIXTURES, expectedText, openFixture } from "./helpers.js";

/** Every paragraph of a story, paragraphs in table cells included, in document order. */
function allParagraphs(blocks: DocxBlock[]): ParagraphBlock[] {
  const found: ParagraphBlock[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") found.push(block);
    else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) found.push(...allParagraphs(cell.blocks));
    }
  }
  return found;
}

function runsOf(story: DocxStory): InlineRun[] {
  return allParagraphs(story.blocks).flatMap((paragraph) => paragraph.runs);
}

interface Summary {
  document: {
    bodyParagraphs: number;
    allParagraphs: number;
    tables: number;
    numberedParagraphs: number;
    paragraphStyles: Record<string, number>;
    hyperlinks: number;
    bookmarks: string[];
    fields: string[];
    footnoteReferences: number;
    pythonDocx: { headings: string[]; sections: number };
  };
  revisions: { total: number; byAuthor: Record<string, number>; paragraphMarkRevisions: number };
  comments: { count: number; replies: number; authors: string[] };
  footnotes: number;
  headers: number;
  footers: number;
}

// The summaries were written by an independent reader (see tests/office/tools), not by this engine.
describe.each(DOCX_FIXTURES)("%s against the independent summary", (name) => {
  const summary = JSON.parse(expectedText(`${name}.summary.json`)) as Summary;

  it("has the same paragraphs, tables, styles and numbered paragraphs", async () => {
    const document = await openFixture(name);
    const view = document.getView();
    const paragraphs = allParagraphs(view.body.blocks);
    expect(view.body.blocks.filter((block) => block.type === "paragraph")).toHaveLength(summary.document.bodyParagraphs);
    expect(paragraphs).toHaveLength(summary.document.allParagraphs);
    expect(view.body.blocks.filter((block) => block.type === "table")).toHaveLength(summary.document.tables);
    expect(paragraphs.filter((paragraph) => paragraph.numbering !== null)).toHaveLength(summary.document.numberedParagraphs);
    expect(view.sections).toHaveLength(summary.document.pythonDocx.sections);

    const styles: Record<string, number> = {};
    for (const paragraph of paragraphs) {
      const id = paragraph.style.styleId;
      if (id !== null && id !== "Normal") styles[id] = (styles[id] ?? 0) + 1;
    }
    expect(styles).toEqual(summary.document.paragraphStyles);
  });

  it("has the same headings, bookmarks, fields, links and notes", async () => {
    const document = await openFixture(name);
    const view = document.getView();
    const paragraphs = allParagraphs(view.body.blocks);
    const titles = paragraphs.filter((paragraph) => paragraph.style.styleId === "Title").map((paragraph) => paragraph.text);
    expect([...titles, ...document.getOutline().map((item) => item.text)]).toEqual(summary.document.pythonDocx.headings);
    expect(paragraphs.flatMap((paragraph) => paragraph.bookmarks).sort()).toEqual(summary.document.bookmarks);

    const runs = runsOf(view.body);
    const fields = new Map<string, string>();
    for (const run of runs) if (run.field !== null) fields.set(run.field.fieldId, run.field.instruction);
    expect([...fields.values()]).toEqual(summary.document.fields);
    const links = new Set(runs.filter((run) => run.hyperlink !== null).map((run) => JSON.stringify(run.hyperlink)));
    expect(links.size).toBe(summary.document.hyperlinks);
    expect(runs.filter((run) => run.footnoteRef !== null)).toHaveLength(summary.document.footnoteReferences);
    expect(view.footnotes).toHaveLength(summary.footnotes);
    expect(view.headers).toHaveLength(summary.headers);
    expect(view.footers).toHaveLength(summary.footers);
  });

  it("accounts for every revision element and every comment", async () => {
    const document = await openFixture(name);
    const groups = getDocxIndex(document).revisions.groups;
    const members = groups.flatMap((group) => group.members.map(() => group.revision.author));
    expect(members).toHaveLength(summary.revisions.total);
    const byAuthor: Record<string, number> = {};
    for (const author of members) byAuthor[author] = (byAuthor[author] ?? 0) + 1;
    expect(byAuthor).toEqual(summary.revisions.byAuthor);
    const marks = groups.flatMap((group) => group.members.filter((member) => member.role === "paragraphMark"));
    expect(marks).toHaveLength(summary.revisions.paragraphMarkRevisions);

    const comments = document.listComments();
    expect(comments).toHaveLength(summary.comments.count);
    expect(comments.filter((comment) => comment.parentId !== null)).toHaveLength(summary.comments.replies);
    expect([...new Set(comments.map((comment) => comment.author))].sort()).toEqual(summary.comments.authors);
    expect(document.getView().commentCount).toBe(summary.comments.count);
    expect(document.getView().revisionCount).toBe(groups.length);
  });

  it("gives the same plain text as the independent reader", async () => {
    const document = await openFixture(name);
    // The independent tool drops soft hyphens; the engine keeps them as U+00AD.
    expect(document.getPlainText().split("­").join("")).toBe(expectedText(`${name}.txt`));
    if (name === "tracked.docx") {
      expect(document.getPlainText({ view: "original" })).toBe(expectedText("tracked.docx.reject.txt"));
    } else {
      expect(document.getPlainText({ view: "original" })).toBe(document.getPlainText({ view: "final" }));
      expect(document.getPlainText({ view: "markup" })).toBe(document.getPlainText({ view: "final" }));
    }
  });

  it("keeps runs a partition of each paragraph's markup text", async () => {
    const view = (await openFixture(name)).getView();
    for (const story of [view.body, ...view.headers, ...view.footers, ...view.footnotes, ...view.endnotes]) {
      for (const paragraph of allParagraphs(story.blocks)) {
        let offset = 0;
        for (const run of paragraph.runs) {
          expect(run.start).toBe(offset);
          expect(run.text.length).toBeGreaterThan(0);
          if (run.object !== null) expect(run.text).toBe("￼");
          offset += run.text.length;
        }
        expect(paragraph.runs.map((run) => run.text).join("")).toBe(paragraph.text);
      }
    }
  });
});
