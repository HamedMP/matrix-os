// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { type Mounted, OTHER, at, bodyParagraphs, caret, mount, paragraph, select } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

function composition(type: "compositionstart" | "compositionend", data: string): void {
  m.content.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: true }));
}

describe("IME composition while someone else edits the document", () => {
  for (const track of [false, true]) {
    it(`inserts the composed text where the caret now is after an assistant insertion before it (tracked: ${track})`, async () => {
      m = await mount({ paragraphs: ["alpha beta gamma"] });
      const [a] = bodyParagraphs(m.doc).map((block) => block.id);
      caret(m, a!, 6);
      composition("compositionstart", "");
      m.session.apply([{ type: "insertText", at: at(a!, 0), text: "XYZ " }], { origin: "agent", track, author: OTHER });
      composition("compositionend", "日本");
      expect(paragraph(m.doc, a!).text).toBe("XYZ alpha 日本beta gamma");
    });
  }

  it("replaces the selection the composition started on, at its new place", async () => {
    m = await mount({ paragraphs: ["alpha beta gamma"] });
    const [a] = bodyParagraphs(m.doc).map((block) => block.id);
    select(m, at(a!, 6), at(a!, 10));
    composition("compositionstart", "");
    m.session.apply([{ type: "insertText", at: at(a!, 0), text: "XYZ " }], { origin: "agent", track: false, author: OTHER });
    composition("compositionend", "日本");
    expect(paragraph(m.doc, a!).text).toBe("XYZ alpha 日本 gamma");
  });
});
