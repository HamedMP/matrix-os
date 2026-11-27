// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PASTE_CHARACTERS } from "../../../../home/apps/docs/src/editor/paste";
import { type Mounted, OTHER, OWNER, at, beforeInput, bodyParagraphs, caret, caretOf, domCaret, finalText, mount, originalText, paragraph, select } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

async function open(paragraphs: string[] = ["Hello world", "Second paragraph"], tracking = false): Promise<string[]> {
  m = await mount({ paragraphs }, { tracking });
  return bodyParagraphs(m.doc).map((block) => block.id);
}

function composition(type: "compositionstart" | "compositionupdate" | "compositionend", data: string): void {
  m.content.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: true }));
}

/** What a browser does while composing: it writes into the text node itself and cannot be stopped. */
function browserWrites(blockId: string, text: string): void {
  const leaf = m.editor.getBlockElement(blockId)!.querySelector("[data-s]")!;
  const event = beforeInput(m, "insertCompositionText", { data: text });
  expect(event.defaultPrevented).toBe(false);
  leaf.firstChild!.nodeValue = `${leaf.firstChild!.nodeValue}${text}`;
  m.content.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", data: text, bubbles: true }));
}

function clipboardEvent(type: "paste" | "copy" | "cut", data: Record<string, string> = {}): { event: Event; written: Record<string, string> } {
  const written: Record<string, string> = {};
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (mime: string) => data[mime] ?? "",
      setData: (mime: string, value: string) => {
        written[mime] = value;
      },
    },
  });
  m.content.dispatchEvent(event);
  return { event, written };
}

describe("IME composition", () => {
  it("lets the browser compose, then discards its DOM and inserts the composed text through the engine", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    composition("compositionstart", "");
    browserWrites(a!, "に");
    browserWrites(a!, "ほん");
    // Nothing reached the model while composing.
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expect(m.session.getState().dirty).toBe(false);
    composition("compositionend", "日本");
    expect(paragraph(m.doc, a!).text).toBe("Hello日本 world");
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello日本 world");
    expect(caretOf(m)).toEqual(at(a!, 7));
    expect(domCaret(m)).toEqual(at(a!, 7));
    m.editor.undo();
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
  });

  it("records composed text as a tracked insertion when tracking is on", async () => {
    const [a] = await open(["Hello world"], true);
    caret(m, a!, 11);
    composition("compositionstart", "");
    browserWrites(a!, "é");
    composition("compositionend", "é");
    expect(m.doc.listRevisions()).toMatchObject([{ kind: "insert", text: "é", author: OWNER }]);
    expect(originalText(m)).toBe("Hello world\n");
    expect(finalText(m)).toBe("Hello worldé\n");
  });

  it("replaces the selection that was active when the composition started", async () => {
    const [a] = await open();
    select(m, at(a!, 6), at(a!, 11));
    composition("compositionstart", "");
    composition("compositionend", "世界");
    expect(paragraph(m.doc, a!).text).toBe("Hello 世界");
    expect(caretOf(m)).toEqual(at(a!, 8));
  });

  it("replaces the word an IME took over, as reported before the browser touched the DOM", async () => {
    const [a] = await open();
    caret(m, a!, 9);
    composition("compositionstart", "");
    // The keyboard recomposes the existing word "world" and reports its range first.
    const text = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    const first = beforeInput(m, "insertCompositionText", { data: "worlds", targetRange: { startContainer: text, startOffset: 6, endContainer: text, endOffset: 11 } });
    expect(first.defaultPrevented).toBe(false);
    text.nodeValue = "Hello worlds";
    // A later report is measured against the changed DOM and must not win.
    beforeInput(m, "insertCompositionText", { data: "worldsx", targetRange: { startContainer: text, startOffset: 0, endContainer: text, endOffset: 12 } });
    composition("compositionend", "worlds");
    expect(paragraph(m.doc, a!).text).toBe("Hello worlds");
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello worlds");
    expect(caretOf(m)).toEqual(at(a!, 12));
  });

  it("restores the paragraph when a composition is cancelled", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    composition("compositionstart", "");
    browserWrites(a!, "x");
    composition("compositionend", "");
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello world");
    expect(m.session.getState().dirty).toBe(false);
    expect(domCaret(m)).toEqual(at(a!, 5));
  });

  it("leaves selected text in place when a composition over it is cancelled", async () => {
    const [a] = await open();
    select(m, at(a!, 6), at(a!, 11));
    composition("compositionstart", "");
    browserWrites(a!, "x");
    composition("compositionend", "");
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello world");
    expect(m.session.getState().dirty).toBe(false);
    expect(m.editor.getSelection()).toMatchObject({ anchor: at(a!, 6), focus: at(a!, 11) });
  });

  it("leaves a word an IME took over in place when that composition is cancelled", async () => {
    const [a] = await open();
    caret(m, a!, 9);
    composition("compositionstart", "");
    const text = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    beforeInput(m, "insertCompositionText", { data: "worlds", targetRange: { startContainer: text, startOffset: 6, endContainer: text, endOffset: 11 } });
    text.nodeValue = "Hello worlds";
    composition("compositionend", "");
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello world");
    expect(m.session.getState().dirty).toBe(false);
  });

  it("holds back rendering of someone else's edit until the composition ends", async () => {
    const [a, b] = await open();
    caret(m, a!, 5);
    composition("compositionstart", "");
    const composing = m.editor.getBlockElement(a!);
    m.session.apply([{ type: "insertText", at: at(b!, 0), text: "Agent: " }], { origin: "agent", track: true, author: OTHER });
    // The paragraph being composed in is not replaced under the IME.
    expect(m.editor.getBlockElement(a!)).toBe(composing);
    expect(m.editor.getBlockElement(b!)!.textContent).toBe("Second paragraph");
    composition("compositionend", "ü");
    expect(m.editor.getBlockElement(b!)!.textContent).toBe("Agent: Second paragraph");
    expect(paragraph(m.doc, a!).text).toBe("Helloü world");
  });

  it("puts composed text where a rejected revision moved its place, and drops it when its place cannot be followed", async () => {
    const [a] = await open(["Hello world"]);
    m.session.apply([{ type: "insertText", at: at(a!, 0), text: "Dear " }], { track: true, author: OTHER });
    caret(m, a!, 10);
    composition("compositionstart", "");
    m.session.rejectRevisions("all", { origin: "agent" });
    composition("compositionend", "!");
    expect(paragraph(m.doc, a!).text).toBe("Hello! world");

    m.session.apply([{ type: "insertText", at: at(a!, 0), text: "Dear " }], { track: true, author: OTHER });
    caret(m, a!, 11);
    composition("compositionstart", "");
    // A custom change positions cannot follow: the composed text is not inserted at the old offset.
    m.session.mutate((doc) => doc.rejectRevisions("all"), { origin: "agent" });
    composition("compositionend", "?");
    expect(paragraph(m.doc, a!).text).toBe("Hello! world");
  });

  it("repairs the DOM when an input got through outside a composition", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    const leaf = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!;
    leaf.firstChild!.nodeValue = "Hello rogue world";
    m.content.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: " rogue", bubbles: true }));
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello world");
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expect(domCaret(m)).toEqual(at(a!, 5));
  });
});

describe("clipboard", () => {
  it("pastes plain text as paragraphs, as one undo step", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    const { event } = clipboardEvent("paste", { "text/plain": ", one\r\ntwo\n\nfour" });
    expect(event.defaultPrevented).toBe(true);
    expect(finalText(m)).toBe("Hello, one\ntwo\n\nfour world\nSecond paragraph\n");
    const last = bodyParagraphs(m.doc)[3]!;
    expect(caretOf(m)).toEqual(at(last.id, 4));
    expect(m.doc.listRevisions()).toEqual([]);
    m.editor.undo();
    expect(finalText(m)).toBe("Hello world\nSecond paragraph\n");
    expect(m.session.getState().canUndo).toBe(false);
  });

  it("keeps bold, italic and underline of pasted HTML and nothing else", async () => {
    const [a] = await open(["Start "]);
    caret(m, a!, 6);
    const html =
      '<meta charset="utf-8"><p style="color:red">plain <b>bold</b> <i>it<u>al</u>ic</i> <span style="font-weight:700">heavy</span></p>' +
      '<script>window.hacked = true</script><p><a href="https://example.com" onclick="steal()">link</a><img src="https://example.com/x.png"></p>';
    beforeInput(m, "insertFromPaste", { transfer: { "text/html": html, "text/plain": "plain bold italic heavy\nlink" } });
    expect(finalText(m)).toBe("Start plain bold italic heavy\nlink\n");
    const runs = paragraph(m.doc, a!).runs.map((run) => [run.text, run.bold, run.italic, run.underline]);
    expect(runs).toEqual([
      ["Start plain ", false, false, false],
      ["bold", true, false, false],
      [" ", false, false, false],
      ["it", false, true, false],
      ["al", false, true, true],
      ["ic", false, true, false],
      [" ", false, false, false],
      ["heavy", true, false, false],
    ]);
    const second = bodyParagraphs(m.doc)[1]!;
    expect(second.runs.every((run) => run.hyperlink === null && run.color === paragraph(m.doc, a!).runs[0]!.color)).toBe(true);
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
    expect(m.host.querySelector("img, script, [onclick]")).toBeNull();
  });

  it("pastes over a selection and records it as tracked changes when tracking is on", async () => {
    const [a] = await open(["Hello world"], true);
    select(m, at(a!, 6), at(a!, 11));
    clipboardEvent("paste", { "text/plain": "there" });
    expect(finalText(m)).toBe("Hello there\n");
    expect(originalText(m)).toBe("Hello world\n");
    expect(m.doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([
      ["delete", "world"],
      ["insert", "there"],
    ]);
  });

  it("strips control characters and the object placeholder from pasted text", async () => {
    const [a] = await open(["A"]);
    caret(m, a!, 1);
    clipboardEvent("paste", { "text/plain": "b\u0000c\u0007￼d\te" });
    expect(paragraph(m.doc, a!).text).toBe("Abcd\te");
  });

  it("copies the selected text as the view shows it and cuts through the engine", async () => {
    const [a, b] = await open();
    select(m, at(a!, 6), at(b!, 6));
    const copied = clipboardEvent("copy");
    expect(copied.event.defaultPrevented).toBe(true);
    expect(copied.written).toEqual({ "text/plain": "world\nSecond" });
    expect(finalText(m)).toBe("Hello world\nSecond paragraph\n");
    const cut = clipboardEvent("cut");
    expect(cut.written).toEqual({ "text/plain": "world\nSecond" });
    expect(finalText(m)).toBe("Hello  paragraph\n");
    expect(caretOf(m)).toEqual(at(a!, 6));
  });

  it("refuses a paste larger than it can insert whole, before changing the document", async () => {
    const refused = vi.fn();
    m = await mount({ paragraphs: ["Hello world"] }, { onClipboardRefused: refused });
    const [a] = bodyParagraphs(m.doc).map((block) => block.id);
    select(m, at(a!, 0), at(a!, 5));
    const big = "x".repeat(MAX_PASTE_CHARACTERS + 1);
    expect(clipboardEvent("paste", { "text/plain": big }).event.defaultPrevented).toBe(true);
    clipboardEvent("paste", { "text/html": `<p><b>${big}</b></p>` });
    beforeInput(m, "insertFromPaste", { transfer: { "text/plain": big } });
    expect(finalText(m)).toBe("Hello world\n");
    expect(m.session.getState().canUndo).toBe(false);
    expect(refused.mock.calls).toEqual([["paste"], ["paste"], ["paste"]]);
  });

  it("copies a selection too large to paste back but does not cut it", async () => {
    const refused = vi.fn();
    const long = "y".repeat(MAX_PASTE_CHARACTERS - 1);
    m = await mount({ paragraphs: [long, "tail"] }, { onClipboardRefused: refused });
    const [a, b] = bodyParagraphs(m.doc).map((block) => block.id);
    select(m, at(a!, 0), at(b!, 2));
    const cut = clipboardEvent("cut");
    expect(cut.event.defaultPrevented).toBe(true);
    expect(cut.written["text/plain"]).toBe(`${long}\nta`);
    expect(finalText(m)).toBe(`${long}\ntail\n`);
    expect(refused.mock.calls).toEqual([["cut"]]);
    // A selection that a paste can put back whole is still cut.
    select(m, at(a!, 0), at(b!, 0));
    expect(clipboardEvent("cut").written["text/plain"]).toBe(`${long}\n`);
    expect(finalText(m)).toBe("tail\n");
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("does not paste or cut while read-only", async () => {
    const [a] = await open();
    m.editor.setReadOnly(true);
    select(m, at(a!, 0), at(a!, 5));
    expect(clipboardEvent("paste", { "text/plain": "x" }).event.defaultPrevented).toBe(true);
    expect(clipboardEvent("cut").written).toEqual({ "text/plain": "Hello" });
    expect(finalText(m)).toBe("Hello world\nSecond paragraph\n");
  });

  it("blocks dragging document text and dropping onto the document", async () => {
    await open();
    for (const type of ["dragstart", "drop"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      m.content.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("lets a drop of files from outside the page through to the app, still blocking text drops", async () => {
    await open();
    const drop = (types: string[]): Event => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types, getData: () => "" } });
      m.content.dispatchEvent(event);
      return event;
    };
    expect(drop(["Files"]).defaultPrevented).toBe(false);
    expect(drop(["text/plain", "text/html"]).defaultPrevented).toBe(true);
    // A file drop nothing else took never turns into pasted text (a file manager also sends its path).
    caret(m, bodyParagraphs(m.doc)[0]!.id, 5);
    expect(beforeInput(m, "insertFromDrop", { transfer: { "text/plain": "/home/owner/Budget.docx" } }).defaultPrevented).toBe(true);
    expect(finalText(m)).toBe("Hello world\nSecond paragraph\n");
  });
});

describe("links", () => {
  it("never navigates on a plain click and opens safe addresses on Ctrl or Cmd click", async () => {
    const opened: string[] = [];
    m = await mount({ markdown: "See [the terms](https://example.com/terms) and [bad](javascript:alert(1))." }, { onOpenLink: (href) => opened.push(href) });
    const links = Array.from(m.host.querySelectorAll<HTMLAnchorElement>("a.doc-link"));
    const safe = links.find((link) => link.textContent === "the terms")!;
    expect(safe.getAttribute("href")).toBe("https://example.com/terms");
    expect(safe.getAttribute("rel")).toContain("noopener");
    // Nothing in the document carries a script address.
    expect(m.host.querySelector('[href^="javascript"]')).toBeNull();
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    safe.firstElementChild!.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(opened).toEqual([]);
    safe.firstElementChild!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(opened).toEqual(["https://example.com/terms"]);
    vi.restoreAllMocks();
  });
});
