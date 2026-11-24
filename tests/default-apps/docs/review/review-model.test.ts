import { describe, expect, it } from "vitest";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { authorColorSlot } from "../../../../home/apps/docs/src/editor/index";
import {
  EMPTY_FILTER,
  authorsOf,
  describeFormatChange,
  excerptOf,
  filterItems,
  formatReviewDate,
  groupByAuthor,
  isFilterActive,
  itemsInRange,
  listReviewItems,
  positionKey,
  revisionKindLabel,
  stepItem,
  type ReviewItem,
} from "../../../../home/apps/docs/src/review/index";
import { ModelIndex } from "../../../../home/apps/docs/src/editor/model-index";
import { ALEX, PRIYA, openFixture } from "./helpers";

async function trackedItems(): Promise<ReviewItem[]> {
  return listReviewItems(await openFixture("tracked.docx"));
}

describe("listReviewItems", () => {
  it("lists every revision of tracked.docx with author, kind, text and location", async () => {
    const items = await trackedItems();
    expect(items).toHaveLength(14);
    const replaced = items.find((item) => item.text === "ten")!;
    expect(replaced).toMatchObject({ kind: "delete", author: PRIYA, category: "substantive", kindLabel: "Deleted", location: "Paragraph 2" });
    expect(replaced.pairedWith).not.toBeNull();
    expect(replaced.colorSlot).toBe(authorColorSlot(PRIYA));
    const bold = items.find((item) => item.scope === "runFormat")!;
    expect(bold).toMatchObject({ kind: "format", category: "formatting", kindLabel: "Formatted", summary: "Bold" });
    const align = items.find((item) => item.scope === "paragraphFormat")!;
    expect(align).toMatchObject({ category: "formatting", kindLabel: "Paragraph formatting", summary: "Alignment: left → center" });
    expect(align.range).toBeNull();
    const row = items.find((item) => item.scope === "tableRow")!;
    expect(row).toMatchObject({ kindLabel: "Row inserted", location: "Table row" });
    const moved = items.find((item) => item.kind === "moveTo")!;
    expect(moved.kindLabel).toBe("Moved to");
  });

  it("puts items in document order: a later paragraph never comes before an earlier one", async () => {
    const doc = await openFixture("tracked.docx");
    const items = listReviewItems(doc);
    const index = ModelIndex.build(doc.getView());
    for (let at = 1; at < items.length; at++) {
      const before = items[at - 1]!.position;
      const after = items[at]!.position;
      expect(before.paragraph < after.paragraph || (before.paragraph === after.paragraph && before.offset <= after.offset)).toBe(true);
    }
    expect(items.map((item) => item.order)).toEqual(items.map((_, at) => at));
    // The inserted table row sits between the governing-law paragraph and the moved paragraph.
    const row = items.findIndex((item) => item.scope === "tableRow");
    expect(items[row - 1]!.scope).toBe("paragraphFormat");
    expect(items[row + 1]!.kind).toBe("moveTo");
    expect(positionKey(index, items[0]!.range!.start)).toEqual(items[0]!.position);
  });

  it("is empty for a document without revisions", () => {
    expect(listReviewItems(createDocx({ paragraphs: ["Plain"] }))).toEqual([]);
  });
});

describe("labels", () => {
  it("names each kind", () => {
    expect(revisionKindLabel("insert", "text")).toBe("Inserted");
    expect(revisionKindLabel("delete", "tableRow")).toBe("Row deleted");
    expect(revisionKindLabel("moveFrom", "text")).toBe("Moved from");
    expect(revisionKindLabel("format", "runFormat")).toBe("Formatted");
  });

  it("describes formatting changes", () => {
    expect(describeFormatChange({ before: { bold: false, italic: true }, after: { bold: true, italic: false } })).toBe("Bold, not italic");
    expect(describeFormatChange({ before: { fontSizePt: 11 }, after: { fontSizePt: 14 } })).toBe("Font size: 11 → 14");
    expect(describeFormatChange(null)).toBe("Formatting");
  });

  it("shortens long text and shows paragraph marks", () => {
    expect(excerptOf("one\ntwo")).toBe("one ¶ two");
    expect(excerptOf("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(excerptOf("")).toBe("(empty)");
  });

  it("formats dates and handles missing or broken ones", () => {
    expect(formatReviewDate(null)).toBe("No date");
    expect(formatReviewDate("not a date")).toBe("No date");
    expect(formatReviewDate("2026-01-05T09:30:00Z")).toMatch(/2026/);
  });
});

describe("grouping and filters", () => {
  it("groups by author in order of first appearance with counts", async () => {
    const groups = groupByAuthor(await trackedItems());
    expect(groups.map((group) => group.author)).toEqual([ALEX, PRIYA]);
    const alex = groups[0]!;
    expect(alex.items.every((item) => item.author === ALEX)).toBe(true);
    expect(alex.formattingCount).toBe(2);
    expect(alex.substantiveCount).toBe(alex.items.length - 2);
    expect(groups[1]!.formattingCount).toBe(0);
  });

  it("filters by author, kind and category", async () => {
    const items = await trackedItems();
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(filterItems(items, EMPTY_FILTER)).toEqual(items);
    const priya = filterItems(items, { ...EMPTY_FILTER, authors: [PRIYA] });
    expect(priya.length).toBeGreaterThan(0);
    expect(priya.every((item) => item.author === PRIYA)).toBe(true);
    const formatting = filterItems(items, { ...EMPTY_FILTER, category: "formatting" });
    expect(formatting.map((item) => item.scope).sort()).toEqual(["paragraphFormat", "runFormat"]);
    const substantive = filterItems(items, { ...EMPTY_FILTER, category: "substantive" });
    expect(substantive).toHaveLength(items.length - 2);
    const moves = filterItems(items, { ...EMPTY_FILTER, kinds: ["moveFrom", "moveTo"] });
    expect(moves.map((item) => item.kind)).toEqual(["moveFrom", "moveTo"]);
    const none = filterItems(items, { authors: [ALEX], kinds: ["delete"], category: "formatting" });
    expect(none).toEqual([]);
    expect(isFilterActive({ ...EMPTY_FILTER, category: "substantive" })).toBe(true);
    expect(authorsOf(items)).toEqual([ALEX, PRIYA]);
  });
});

describe("stepping", () => {
  it("visits every item in document order forwards and backwards", async () => {
    const items = await trackedItems();
    const forward: string[] = [];
    let current: ReviewItem | null = stepItem(items, { currentId: null }, "next");
    while (current !== null) {
      forward.push(current.id);
      current = stepItem(items, { currentId: current.id }, "next");
    }
    expect(forward).toEqual(items.map((item) => item.id));
    const backward: string[] = [];
    current = stepItem(items, { currentId: null }, "previous");
    while (current !== null) {
      backward.push(current.id);
      current = stepItem(items, { currentId: current.id }, "previous");
    }
    expect(backward).toEqual([...forward].reverse());
  });

  it("starts from the caret when nothing is current", async () => {
    const items = await trackedItems();
    const third = items[2]!;
    const caret = { paragraph: third.position.paragraph, offset: third.position.offset };
    expect(stepItem(items, { currentId: null, caret }, "next")!.id).toBe(third.id);
    expect(stepItem(items, { currentId: null, caret }, "previous")!.id).toBe(items[1]!.id);
    expect(stepItem([], { currentId: null }, "next")).toBeNull();
    // An id that is no longer listed falls back to the caret.
    expect(stepItem(items, { currentId: "gone", caret }, "next")!.id).toBe(third.id);
  });
});

describe("itemsInRange", () => {
  it("finds the revisions a selection touches", async () => {
    const doc = await openFixture("tracked.docx");
    const items = listReviewItems(doc);
    const index = ModelIndex.build(doc.getView());
    const fifteen = items.find((item) => item.text === "fifteen")!;
    const ten = items.find((item) => item.text === "ten")!;
    const blockId = fifteen.range!.start.blockId;
    // A selection over "tenfifteen".
    const both = itemsInRange(items, index, { start: ten.range!.start, end: fifteen.range!.end });
    expect(both.map((item) => item.id).sort()).toEqual([ten.id, fifteen.id].sort());
    // A caret inside "fifteen".
    const caret = { blockId, offset: fifteen.range!.start.offset + 2 };
    expect(itemsInRange(items, index, { start: caret, end: caret }).map((item) => item.id)).toEqual([fifteen.id]);
    // The whole body touches everything, including revisions without a text range.
    const paragraphs = doc.getView().body.blocks.filter((block) => block.type === "paragraph");
    const first = paragraphs[0]!;
    const last = paragraphs[paragraphs.length - 1]!;
    const all = itemsInRange(items, index, { start: { blockId: first.id, offset: 0 }, end: { blockId: last.id, offset: 3 } });
    expect(all).toHaveLength(items.length);
  });
});
