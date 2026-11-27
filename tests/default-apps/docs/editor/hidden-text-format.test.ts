// @vitest-environment jsdom
/**
 * Formatting commands in the final view leave alone the text the view hides
 * (pending deletions), as deleting and typing do: rejecting such a deletion
 * later brings the text back as it was, not with formatting the owner applied
 * to what they could see.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { DATE, type Mounted, OTHER, at, bodyParagraphs, finalText, mount, paragraph, select } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

/** "Hello brave world" and "Second hidden part" with "brave " and "hidden " deleted by another author. */
async function openWithHiddenDeletions(tracking = false): Promise<string[]> {
  const doc = createDocx({ paragraphs: ["Hello brave world", "Second hidden part", "Third"] });
  const [a, b] = bodyParagraphs(doc).map((block) => block.id);
  doc.applyOps(
    [
      { type: "deleteRange", range: { start: at(b!, 7), end: at(b!, 14) } },
      { type: "deleteRange", range: { start: at(a!, 6), end: at(a!, 12) } },
    ],
    { track: true, author: OTHER, date: DATE },
  );
  m = await mount({ doc }, { viewMode: "final", tracking });
  return bodyParagraphs(m.doc).map((block) => block.id);
}

/** Each run's text with whether it is bold, in order. */
function boldRuns(blockId: string): Array<[string, boolean]> {
  return paragraph(m.doc, blockId).runs.map((run) => [run.text, run.bold]);
}

describe("formatting in the final view with hidden pending deletions", () => {
  it("bolds only the visible stretches of a selection inside one paragraph", async () => {
    const [a] = await openWithHiddenDeletions();
    // "Hel|lo world|" as shown: "brave " lies hidden inside the selection.
    select(m, at(a!, 3), at(a!, 17));
    expect(m.editor.toggleFormat("bold")).toBe(true);
    expect(boldRuns(a!)).toEqual([
      ["Hel", false],
      ["lo ", true],
      ["brave ", false],
      ["world", true],
    ]);
    m.doc.rejectRevisions("all");
    expect(boldRuns(a!).find(([text]) => text.includes("brave"))?.[1]).toBe(false);
  });

  it("formats only visible text across paragraphs, then the rejected deletions come back unformatted", async () => {
    const [a, b] = await openWithHiddenDeletions();
    select(m, at(a!, 3), at(b!, 16));
    expect(m.editor.format({ bold: true, color: "#c00000" })).toBe(true);
    const formatted = (blockId: string) => paragraph(m.doc, blockId).runs.map((run) => [run.text, run.bold, run.color === "#c00000"]);
    expect(formatted(a!)).toEqual([
      ["Hel", false, false],
      ["lo ", true, true],
      ["brave ", false, false],
      ["world", true, true],
    ]);
    expect(formatted(b!)).toEqual([
      ["Second ", true, true],
      ["hidden ", false, false],
      ["pa", true, true],
      ["rt", false, false],
    ]);
    m.doc.rejectRevisions("all");
    expect(finalText(m)).toBe("Hello brave world\nSecond hidden part\nThird\n");
    const hidden = [...paragraph(m.doc, a!).runs, ...paragraph(m.doc, b!).runs].filter((run) => run.text.includes("brave") || run.text.includes("hidden"));
    expect(hidden.map((run) => [run.text, run.bold, run.color === "#c00000"])).toEqual([
      ["brave ", false, false],
      ["hidden ", false, false],
    ]);
  });

  it("with Track changes on, records formatting only on the visible text", async () => {
    const [a] = await openWithHiddenDeletions(true);
    select(m, at(a!, 3), at(a!, 17));
    expect(m.editor.toggleFormat("italic")).toBe(true);
    expect(paragraph(m.doc, a!).runs.map((run) => [run.text, run.italic])).toEqual([
      ["Hel", false],
      ["lo ", true],
      ["brave ", false],
      ["world", true],
    ]);
  });

  it("still formats a selection with nothing hidden in one range, paragraph marks included", async () => {
    m = await mount({ paragraphs: ["One", "Two"] }, { viewMode: "final" });
    const [a, b] = bodyParagraphs(m.doc).map((block) => block.id);
    select(m, at(a!, 0), at(b!, 3));
    expect(m.editor.toggleFormat("bold")).toBe(true);
    expect([...boldRuns(a!), ...boldRuns(b!)]).toEqual([
      ["One", true],
      ["Two", true],
    ]);
  });
});

describe("paragraph formatting in the final view", () => {
  it("leaves a paragraph the view hides entirely alone", async () => {
    const doc = createDocx({ paragraphs: ["Intro", "Gone entirely", "Outro"] });
    const [a, b, c] = bodyParagraphs(doc).map((block) => block.id);
    // The whole second paragraph, its mark included, is a pending deletion.
    doc.applyOps([{ type: "deleteRange", range: { start: at(b!, 0), end: at(c!, 0) } }], { track: true, author: OTHER, date: DATE });
    m = await mount({ doc }, { viewMode: "final" });
    expect(finalText(m)).toBe("Intro\nOutro\n");
    select(m, at(a!, 0), at(c!, 5));
    expect(m.editor.setParagraphStyle({ alignment: "center" })).toBe(true);
    expect(paragraph(m.doc, a!).style.alignment).toBe("center");
    expect(paragraph(m.doc, c!).style.alignment).toBe("center");
    expect(paragraph(m.doc, b!).style.alignment).not.toBe("center");
    m.doc.rejectRevisions("all");
    expect(paragraph(m.doc, b!).style.alignment).not.toBe("center");
  });
});
