import { describe, expect, it } from "vitest";

import type { InlineRun } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { openFixture, paragraphStarting, paragraphsOf } from "./helpers.js";

describe("comments (comments.docx)", () => {
  it("lists comments in anchor order with replies after their thread's first comment", async () => {
    const document = await openFixture("comments.docx");
    const view = document.getView();
    const move = paragraphStarting(view.body, "We propose moving");
    const rent = paragraphStarting(view.body, "The expected annual rent");
    expect(document.listComments()).toEqual([
      {
        id: "0",
        parentId: null,
        author: "Alex Morgan",
        initials: "AM",
        date: "2026-01-05T09:30:00Z",
        text: "Is parking included in this building?",
        range: { start: { blockId: move.id, offset: 21 }, end: { blockId: move.id, offset: 43 } },
        anchorText: "the riverside building",
        resolved: false,
      },
      {
        id: "2",
        parentId: "0",
        author: "Priya Shah",
        initials: "PS",
        date: "2026-01-06T14:20:00Z",
        text: "Yes, 40 spaces are included.",
        range: { start: { blockId: move.id, offset: 21 }, end: { blockId: move.id, offset: 43 } },
        anchorText: "the riverside building",
        resolved: false,
      },
      {
        id: "1",
        parentId: null,
        author: "Priya Shah",
        initials: "PS",
        date: "2026-01-06T14:15:00Z",
        text: "Please confirm whether this figure includes VAT.",
        range: { start: { blockId: rent.id, offset: 28 }, end: { blockId: rent.id, offset: 39 } },
        anchorText: "EUR 240,000",
        resolved: false,
      },
    ]);
    expect(move.text.slice(21, 43)).toBe("the riverside building");
    expect(view.commentCount).toBe(3);
  });

  it("puts the ids of covering comments on the runs, and no text for reference marks", async () => {
    const view = (await openFixture("comments.docx")).getView();
    const move = paragraphStarting(view.body, "We propose moving");
    expect(move.text).toBe("We propose moving to the riverside building by the end of the year.");
    expect(move.runs.map((run) => [run.text, run.commentIds])).toEqual([
      ["We propose moving to ", []],
      ["the riverside building", ["0", "2"]],
      [" by the end of the year.", []],
    ]);
    const rent = paragraphStarting(view.body, "The expected annual rent");
    expect(rent.runs.map((run) => run.commentIds)).toEqual([[], ["1"], []]);
  });

  it("has no comments in a document without a comments part", async () => {
    expect((await openFixture("basic.docx")).listComments()).toEqual([]);
  });
});

describe("notes, headers and footers (footnotes-headers.docx)", () => {
  it("exposes one story per footnote in reference order, without the separators", async () => {
    const document = await openFixture("footnotes-headers.docx");
    const view = document.getView();
    expect(view.footnotes.map((story) => [story.id, story.kind, story.label])).toEqual([
      ["footnote:1", "footnote", "Footnote 1"],
      ["footnote:2", "footnote", "Footnote 2"],
      ["footnote:3", "footnote", "Footnote 3"],
    ]);
    expect(view.footnotes.map((story) => document.getPlainText({ storyId: story.id }))).toEqual([
      " Internal productivity study, 2025.\n",
      " Engineering roles showed the largest change.\n",
      " Subject to budget approval.\n",
    ]);
    const first = paragraphsOf(view.footnotes[0]!)[0]!;
    expect(first.style.styleId).toBe("FootnoteText");
    expect(first.text).toBe("￼ Internal productivity study, 2025.");
    expect(first.runs[0]).toMatchObject({
      object: { kind: "noteReference" },
      footnoteRef: { kind: "footnote", storyId: "footnote:1", label: "1" },
      verticalAlign: "superscript",
    });
    expect(view.endnotes).toEqual([]);
  });

  it("marks footnote references in the body with the story they point at", async () => {
    const view = (await openFixture("footnotes-headers.docx")).getView();
    const body = paragraphStarting(view.body, "Remote work");
    expect(body.text).toBe("Remote work increased output in most teams￼ although results varied by role.￼");
    const references = body.runs.filter((run) => run.footnoteRef !== null);
    expect(references.map((run) => [run.start, run.text, run.footnoteRef, run.object])).toEqual([
      [42, "￼", { kind: "footnote", storyId: "footnote:1", label: "1" }, { kind: "noteReference" }],
      [76, "￼", { kind: "footnote", storyId: "footnote:2", label: "2" }, { kind: "noteReference" }],
    ]);
    expect(references.every((run) => run.verticalAlign === "superscript")).toBe(true);
  });

  it("exposes header and footer stories and links them from the section", async () => {
    const document = await openFixture("footnotes-headers.docx");
    const view = document.getView();
    expect(view.headers.map((story) => [story.id, story.kind, story.label])).toEqual([
      ["header:/word/header1.xml", "header", "Header"],
    ]);
    expect(view.footers.map((story) => [story.id, story.kind, story.label])).toEqual([
      ["footer:/word/footer1.xml", "footer", "Footer"],
    ]);
    expect(view.sections[0]?.headers).toEqual({ default: "header:/word/header1.xml" });
    expect(view.sections[0]?.footers).toEqual({ default: "footer:/word/footer1.xml" });
    expect(document.getPlainText({ storyId: "header:/word/header1.xml" })).toBe("Matrix OS fixture – Confidential\n");
    expect(document.getStory("footer:/word/footer1.xml")).toEqual(view.footers[0]);
  });

  it("shows field results as text and describes complex and simple fields", async () => {
    const view = (await openFixture("footnotes-headers.docx")).getView();
    const footer = paragraphsOf(view.footers[0]!)[0]!;
    expect(footer.text).toBe("Page 1 of 1");
    const fields = footer.runs.map((run: InlineRun) => [run.text, run.field?.kind ?? null, run.field?.instruction ?? null]);
    expect(fields).toEqual([
      ["Page ", null, null],
      ["1", "page", "PAGE"],
      [" of ", null, null],
      ["1", "numPages", "NUMPAGES"],
    ]);
    const ids = footer.runs.filter((run) => run.field !== null).map((run) => run.field!.fieldId);
    expect(new Set(ids).size).toBe(2);
  });

  it("gives every story unique block ids and rejects an unknown story", async () => {
    const document = await openFixture("footnotes-headers.docx");
    const view = document.getView();
    const ids = [view.body, ...view.headers, ...view.footers, ...view.footnotes].flatMap((story) => story.blocks.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => document.getPlainText({ storyId: "footnote:99" })).toThrowError(
      expect.toSatisfy((error) => isOfficeError(error, "stale_reference")),
    );
  });
});
