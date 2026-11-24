import { describe, expect, it } from "vitest";

import { createElement, parseXml } from "../../../../packages/office/src/xml/index.js";
import {
  NumberingDefinitions,
  buildLabelIndex,
  formatCounter,
  getDocxIndex,
  toLetters,
  toRoman,
  typedLabel,
} from "../../../../packages/office/src/docx/internal.js";
import { computeNumberingLabels } from "../../../../packages/office/src/docx/model/numbering.js";
import { openFixture, paragraphsOf } from "./helpers.js";

describe("numbering labels (numbering.docx)", () => {
  it("labels every numbered paragraph in document order", async () => {
    const view = (await openFixture("numbering.docx")).getView();
    const labels = paragraphsOf(view.body).map((p) => [p.text, p.numbering?.text ?? null]);
    expect(labels).toEqual([
      ["Numbered and bulleted lists", null],
      ["Multi-level list (1 / 1.1 / (a)):", null],
      ["Scope of work", "1."],
      ["Discovery workshops", "1.1."],
      ["Stakeholder interviews", "(a)"],
      ["Current-state process maps", "(b)"],
      ["Implementation", "1.2."],
      ["Acceptance", "2."],
      ["Acceptance criteria", "2.1."],
      ["Sign-off by the owner", "(a)"],
      ["Bulleted list:", null],
      ["Coffee", "•"],
      ["Tea", "•"],
      ["Green tea", "–"],
      ["Water", "•"],
      ["A second numbered list that restarts at 1:", null],
      ["Collect feedback", "1."],
      ["Group feedback by theme", "1.1."],
      ["Publish the summary", "2."],
    ]);
  });

  it("reports level, instance, format and counters", async () => {
    const view = (await openFixture("numbering.docx")).getView();
    const byText = new Map(paragraphsOf(view.body).map((p) => [p.text, p.numbering]));
    expect(byText.get("Current-state process maps")).toEqual({
      text: "(b)",
      level: 2,
      numId: "1",
      format: "lowerLetter",
      counters: [1, 1, 2],
    });
    expect(byText.get("Acceptance criteria")).toEqual({ text: "2.1.", level: 1, numId: "1", format: "decimal", counters: [2, 1] });
    expect(byText.get("Green tea")).toEqual({ text: "–", level: 1, numId: "2", format: "bullet", counters: [] });
    // numId 3 shares the abstract definition of numId 1 and restarts it with a start override.
    expect(byText.get("Publish the summary")).toEqual({ text: "2.", level: 0, numId: "3", format: "decimal", counters: [2] });
  });

  it("applies the indent of the numbering level over the paragraph style", async () => {
    const view = (await openFixture("numbering.docx")).getView();
    const byText = new Map(paragraphsOf(view.body).map((p) => [p.text, p.style]));
    expect(byText.get("Scope of work")).toMatchObject({ styleId: "ListParagraph", indentLeftPt: 18, firstLineIndentPt: -18 });
    expect(byText.get("Stakeholder interviews")).toMatchObject({ indentLeftPt: 61.2, firstLineIndentPt: -18 });
  });
});

describe("typed clause labels (contract.docx)", () => {
  it("has no automatic numbering but recognises the typed numbers as labels", async () => {
    const document = await openFixture("contract.docx");
    const view = document.getView();
    expect(paragraphsOf(view.body).every((p) => p.numbering === null)).toBe(true);

    const index = getDocxIndex(document);
    const labels = buildLabelIndex(index);
    const keyOf = (prefix: string): string | undefined => {
      const block = paragraphsOf(view.body).find((p) => p.text.startsWith(prefix));
      const record = block === undefined ? null : index.block(block.id);
      return record === null ? undefined : labels.byParagraph.get(record.element)?.key;
    };
    expect(keyOf("1. Definitions")).toBe("1");
    expect(keyOf("1.1\t")).toBe("1.1");
    expect(keyOf("8.2\t")).toBe("8.2");
    expect(keyOf("10.2\t")).toBe("10.2");
    expect(keyOf("(b)\tfails to meet")).toBe("10.2(b)");
    expect(keyOf("12.5\t")).toBe("12.5");
    expect(keyOf("Schedule 1")).toBe("schedule 1");
    expect(keyOf("(a)\tMonthly dashboards")).toBe("schedule 1(a)");
    // Party and recital letters come before any clause.
    expect(keyOf("(1)\tHarbourline")).toBe("(1)");
    expect(keyOf("This Agreement is dated")).toBeUndefined();
    // 12 clause headings, their 34 sub-clauses, 3 + 5 lettered items, 2 parties, 2 recitals and the schedule.
    expect(labels.byParagraph.size).toBe(59);
    expect(labels.byKey.get("10.2(b)")?.id).toBe(paragraphsOf(view.body).find((p) => p.text.startsWith("(b)\tfails"))?.id);
  });

  it("tells typed labels from prose", () => {
    expect(typedLabel("8.2\tSubject to clause 8.1", false)).toBe("8.2");
    expect(typedLabel("1. Definitions and interpretation", true)).toBe("1.");
    expect(typedLabel("3.4 The Customer shall", false)).toBe("3.4");
    expect(typedLabel("(a)\tcommits a material breach", false)).toBe("(a)");
    expect(typedLabel("(iv) a longer item", false)).toBe("(iv)");
    expect(typedLabel("2 Term", true)).toBe("2");
    expect(typedLabel("Schedule 1 – Service description", true)).toBe("Schedule 1");
    expect(typedLabel("24 months after the Commencement Date", false)).toBeNull();
    expect(typedLabel("Schedule 1 is attached", false)).toBeNull();
    expect(typedLabel("(see above) and so on", false)).toBeNull();
    expect(typedLabel("", false)).toBeNull();
  });
});

describe("counter formats", () => {
  it("formats decimal, letters and roman numerals", () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999].map(toRoman)).toEqual([
      "I", "IV", "IX", "XIV", "XL", "XC", "CD", "MCMXCIV", "MMMCMXCIX",
    ]);
    expect(toRoman(0)).toBe("0");
    expect([1, 26, 27, 28, 52, 53].map(toLetters)).toEqual(["a", "z", "aa", "bb", "zz", "aaa"]);
    expect(formatCounter(3, "decimal")).toBe("3");
    expect(formatCounter(3, "upperLetter")).toBe("C");
    expect(formatCounter(4, "lowerRoman")).toBe("iv");
    expect(formatCounter(4, "upperRoman")).toBe("IV");
    expect(formatCounter(7, "decimalZero")).toBe("07");
    expect(formatCounter(22, "ordinal")).toBe("22nd");
    expect(formatCounter(5, "chicago")).toBe("5");
  });

  function definitions(xml: string): NumberingDefinitions {
    return new NumberingDefinitions(parseXml(`<w:numbering xmlns:w="urn:w">${xml}</w:numbering>`).root, () => null);
  }
  const level = (ilvl: number, numFmt: string, text: string, extra = ""): string =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`;
  const labelsOf = (defs: NumberingDefinitions, sequence: Array<[string, number]>): string[] => {
    const paragraphs = sequence.map(([numId, lvl]) => ({ element: createElement("w:p"), numId, level: lvl }));
    const labels = computeNumberingLabels(paragraphs, defs);
    return paragraphs.map((paragraph) => labels.get(paragraph.element)?.text ?? "?");
  };

  it("counts multi-level patterns, restarts lower levels and honours roman and letter formats", () => {
    const defs = definitions(
      `<w:abstractNum w:abstractNumId="0">${level(0, "upperRoman", "Article %1")}${level(1, "decimal", "%1.%2")}${level(2, "lowerLetter", "(%3)")}${level(3, "lowerRoman", "(%4)")}</w:abstractNum>` +
        `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
    );
    expect(labelsOf(defs, [["1", 0], ["1", 1], ["1", 2], ["1", 3], ["1", 3], ["1", 2], ["1", 1], ["1", 0], ["1", 1], ["1", 2]])).toEqual([
      "Article I", "I.1", "(a)", "(i)", "(ii)", "(b)", "I.2", "Article II", "II.1", "(a)",
    ]);
  });

  it("starts at w:start, writes legal numbering as decimal and keeps a level that never restarts", () => {
    const defs = definitions(
      `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="4"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1"/></w:lvl>` +
        `${level(1, "decimal", "%1.%2", "<w:isLgl/>")}${level(2, "decimal", "Note %3", '<w:lvlRestart w:val="0"/>')}</w:abstractNum>` +
        `<w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num>`,
    );
    expect(labelsOf(defs, [["7", 0], ["7", 1], ["7", 2], ["7", 0], ["7", 1], ["7", 2]])).toEqual([
      "IV", "4.1", "Note 1", "V", "5.1", "Note 2",
    ]);
  });

  it("continues a list across instances of one definition unless a start override restarts it", () => {
    const defs = definitions(
      `<w:abstractNum w:abstractNumId="0">${level(0, "decimal", "%1.")}</w:abstractNum>` +
        `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
        `<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>` +
        `<w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride></w:num>`,
    );
    expect(labelsOf(defs, [["1", 0], ["1", 0], ["2", 0], ["3", 0], ["3", 0], ["9", 0]])).toEqual(["1.", "2.", "3.", "10.", "11.", "?"]);
  });

  it("shows the start value of levels a list skipped", () => {
    const defs = definitions(
      `<w:abstractNum w:abstractNumId="0">${level(0, "decimal", "%1")}${level(1, "decimal", "%1.%2")}</w:abstractNum>` +
        `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
    );
    expect(labelsOf(defs, [["1", 1], ["1", 1], ["1", 0]])).toEqual(["1.1", "1.2", "2"]);
  });
});
