import { describe, expect, it } from "vitest";
import { createDocx, createDocxFromMarkdown } from "../../../../home/apps/_shared/office-engine/index";
import type { DocxDocument, ParagraphBlock } from "../../../../home/apps/_shared/office-engine/index";
import { findMatches, replaceOps } from "../../../../home/apps/docs/src/ui/find-model";
import { visibleParagraphs } from "../../../../home/apps/docs/src/ui/text-index";
import { blockOrder, buildOutline, currentOutlineEntry } from "../../../../home/apps/docs/src/ui/outline-model";
import { buildReferenceIndex, referenceIdsAt, referenceInfo } from "../../../../home/apps/docs/src/ui/references-model";
import { breadcrumbs, isDocxPath, parentOf, pickerEntries } from "../../../../home/apps/docs/src/ui/file-picker-model";
import { countWords, describeSaveState } from "../../../../home/apps/docs/src/ui/status-model";
import { buildExport } from "../../../../home/apps/docs/src/ui/exports";
import type { SessionState } from "../../../../home/apps/docs/src/session/index";

const OWNER = "Rae Okafor";
const DATE = "2026-11-20T09:00:00Z";

function paragraphs(doc: DocxDocument): ParagraphBlock[] {
  return doc.getView().body.blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");
}

const CONTRACT = [
  "# Definitions",
  "",
  '"Agreement" means this agreement between the parties.',
  "",
  "The Agreement starts today. An agreement in lower case is not the term.",
  "",
  "1. Scope",
  "2. Payment terms as in Clause 1 apply.",
  "",
  "# Term",
  "",
  "Ends when Clause 9 says so.",
].join("\n");

describe("find model", () => {
  it("finds matches case-insensitively by default and as whole words on request", () => {
    const doc = createDocx({ paragraphs: ["Cat cat catalog", "the CAT sat"] });
    const view = visibleParagraphs(doc, "markup");
    expect(findMatches(view, "cat").matches.map((match) => match.text)).toEqual(["Cat", "cat", "cat", "CAT"]);
    expect(findMatches(view, "cat", { matchCase: true }).matches).toHaveLength(2);
    const whole = findMatches(view, "cat", { wholeWord: true }).matches;
    expect(whole.map((match) => match.text)).toEqual(["Cat", "cat", "CAT"]);
    const [first] = paragraphs(doc);
    expect(whole[1]!.range).toEqual({ start: { blockId: first!.id, offset: 4 }, end: { blockId: first!.id, offset: 7 } });
  });

  it("treats the query literally and caps the number of matches", () => {
    const doc = createDocx({ paragraphs: ["a.b a+b (a) a.b"] });
    const view = visibleParagraphs(doc, "markup");
    expect(findMatches(view, "a.b").matches).toHaveLength(2);
    expect(findMatches(view, "(a)").matches).toHaveLength(1);
    expect(findMatches(view, "").matches).toHaveLength(0);
    const capped = findMatches(view, "a", {}, 2);
    expect(capped.matches).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it("skips text a view hides and maps matches to markup offsets", () => {
    const doc = createDocx({ paragraphs: ["alpha beta gamma"] });
    const [block] = paragraphs(doc);
    doc.applyOps(
      [{ type: "deleteRange", range: { start: { blockId: block!.id, offset: 6 }, end: { blockId: block!.id, offset: 11 } } }],
      { track: true, author: OWNER, date: DATE },
    );
    expect(findMatches(visibleParagraphs(doc, "final"), "beta").matches).toHaveLength(0);
    expect(findMatches(visibleParagraphs(doc, "markup"), "beta").matches).toHaveLength(1);
    const gamma = findMatches(visibleParagraphs(doc, "final"), "alpha gamma").matches;
    expect(gamma).toHaveLength(1);
    expect(gamma[0]!.range.start.offset).toBe(0);
    expect(gamma[0]!.range.end.offset).toBe(16);
  });

  it("builds replacement operations from the end of the document backwards", () => {
    const doc = createDocx({ paragraphs: ["one two one", "one"] });
    const matches = findMatches(visibleParagraphs(doc, "markup"), "one").matches;
    const ops = replaceOps(matches, "three");
    expect(ops.map((op) => (op.type === "replaceRange" ? op.range.start.offset : -1))).toEqual([0, 8, 0]);
    doc.applyOps(ops, { track: false, author: OWNER, date: DATE });
    expect(doc.getPlainText()).toBe("three two three\nthree\n");
  });

  it("searches inside table cells", () => {
    const doc = createDocxFromMarkdown("| Name | Value |\n| --- | --- |\n| needle | 2 |\n");
    expect(findMatches(visibleParagraphs(doc, "markup"), "needle").matches).toHaveLength(1);
  });
});

describe("outline model", () => {
  it("lists headings and numbered clauses in document order", () => {
    const doc = createDocxFromMarkdown(CONTRACT);
    const outline = buildOutline(doc);
    expect(outline.map((entry) => [entry.kind, entry.label, entry.text])).toEqual([
      ["heading", null, "Definitions"],
      ["clause", "1.", "Scope"],
      ["clause", "2.", "Payment terms as in Clause 1 apply."],
      ["heading", null, "Term"],
    ]);
  });

  it("finds the entry that contains a block", () => {
    const doc = createDocxFromMarkdown(CONTRACT);
    const outline = buildOutline(doc);
    const order = blockOrder(doc);
    const blocks = paragraphs(doc);
    const intro = blocks.find((block) => block.text.startsWith("The Agreement"))!;
    expect(currentOutlineEntry(outline, order, intro.id)).toBe(outline[0]!.blockId);
    const last = blocks[blocks.length - 1]!;
    expect(currentOutlineEntry(outline, order, last.id)).toBe(outline[3]!.blockId);
    expect(currentOutlineEntry(outline, order, null)).toBeNull();
  });
});

describe("references model", () => {
  it("highlights uses of defined terms, not the definition itself, and cross-references", () => {
    const doc = createDocxFromMarkdown(CONTRACT);
    const index = buildReferenceIndex(doc);
    expect(index.terms).toHaveLength(1);
    const use = index.terms[0]!;
    const usePara = paragraphs(doc).find((block) => block.id === use.range.start.blockId)!;
    expect(usePara.text.slice(use.range.start.offset, use.range.end.offset)).toBe("Agreement");
    expect(usePara.text.startsWith("The Agreement")).toBe(true);
    const term = referenceInfo(index, use.id!);
    expect(index.ranges.get(use.id!)).toEqual(use.range);
    expect(term).toMatchObject({ kind: "term", term: "Agreement", definition: "means this agreement between the parties." });

    expect(index.xrefs).toHaveLength(2);
    const good = referenceInfo(index, index.xrefs[0]!.id!);
    expect(good).toMatchObject({ kind: "xref", text: "Clause 1", label: "1.", preview: "Scope", broken: false });
    const broken = referenceInfo(index, index.xrefs[1]!.id!);
    expect(broken).toMatchObject({ kind: "xref", text: "Clause 9", broken: true, targetBlockId: null });
    expect(index.xrefs[1]!.className).toContain("is-broken");
  });

  it("reads reference ids from highlighted elements", () => {
    const span = { getAttribute: (name: string) => (name === "data-hl-id" ? "find:1 term:0.3 xref:2" : null) } as unknown as Element;
    expect(referenceIdsAt(span)).toEqual(["term:0.3", "xref:2"]);
  });
});

describe("file picker model", () => {
  const entry = (name: string, kind: "file" | "dir", dir = "") => ({
    name,
    path: dir === "" ? name : `${dir}/${name}`,
    kind,
    size: 0,
    modifiedAt: "2026-11-20T09:00:00.000Z",
  });

  it("keeps folders and Word documents and hides protected and hidden entries", () => {
    const listed = [
      entry("system", "dir"),
      entry("agents", "dir"),
      entry(".cache", "dir"),
      entry("Documents", "dir"),
      entry("plan.docx", "file"),
      entry("PLAN2.DOCX", "file"),
      entry("~$plan.docx", "file"),
      entry("sheet.xlsx", "file"),
      entry("notes.md", "file"),
    ];
    expect(pickerEntries("", listed).map((item) => item.name)).toEqual(["Documents", "plan.docx", "PLAN2.DOCX"]);
    expect(pickerEntries("Documents", [entry("system", "dir", "Documents")]).map((item) => item.name)).toEqual(["system"]);
  });

  it("builds breadcrumbs and parents", () => {
    expect(breadcrumbs("")).toEqual([{ label: "Home", path: "" }]);
    expect(breadcrumbs("Documents/Legal")).toEqual([
      { label: "Home", path: "" },
      { label: "Documents", path: "Documents" },
      { label: "Legal", path: "Documents/Legal" },
    ]);
    expect(parentOf("Documents/Legal")).toBe("Documents");
    expect(parentOf("Documents")).toBe("");
    expect(isDocxPath("a/b.DocX")).toBe(true);
    expect(isDocxPath("a/b.doc")).toBe(false);
    expect(isDocxPath("../b.docx")).toBe(false);
  });
});

describe("status model", () => {
  const base: SessionState = {
    status: "ready",
    source: "matrix",
    path: "plan.docx",
    name: "plan.docx",
    version: "v1",
    dirty: false,
    saveStatus: "idle",
    saveError: null,
    conflict: null,
    error: null,
    tracking: false,
    autosave: true,
    canUndo: false,
    canRedo: false,
    revisionCount: 0,
    commentCount: 0,
    lastSavedAt: null,
    documentKey: 1,
  };

  it("describes each save state", () => {
    expect(describeSaveState(base)).toEqual({ tone: "saved", label: "Saved" });
    expect(describeSaveState({ ...base, dirty: true })).toEqual({ tone: "unsaved", label: "Unsaved changes" });
    expect(describeSaveState({ ...base, dirty: true, saveStatus: "saving" })).toEqual({ tone: "saving", label: "Saving…" });
    expect(describeSaveState({ ...base, dirty: true, saveStatus: "error" })).toEqual({ tone: "error", label: "Not saved" });
    expect(describeSaveState({ ...base, conflict: { path: "plan.docx", detectedAt: DATE } }).tone).toBe("conflict");
    expect(describeSaveState({ ...base, path: null })).toEqual({ tone: "draft", label: "Not saved yet" });
  });

  it("describes a document from the computer by its downloads", () => {
    const local = { ...base, source: "local" as const, path: null };
    expect(describeSaveState(local)).toEqual({ tone: "saved", label: "Not changed" });
    expect(describeSaveState({ ...local, dirty: true })).toEqual({ tone: "unsaved", label: "Unsaved changes" });
    expect(describeSaveState({ ...local, saveStatus: "saved" })).toEqual({ tone: "saved", label: "Downloaded" });
    expect(describeSaveState({ ...local, dirty: true, saveStatus: "error" })).toEqual({ tone: "error", label: "Not saved" });
  });

  it("counts words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("Hello, world!\nIt's 2026 — a well-known fact.")).toBe(7);
  });
});

describe("exports", () => {
  it("exports HTML, Markdown and plain text named after the document", () => {
    const doc = createDocxFromMarkdown("# Title\n\nSome **bold** text.\n");
    const html = buildExport(doc, "html", "markup", "plan.docx");
    expect(html.fileName).toBe("plan.html");
    expect(html.mimeType).toBe("text/html");
    expect(html.content).toContain("<h1");
    const md = buildExport(doc, "markdown", "markup", "plan.docx");
    expect(md.fileName).toBe("plan.md");
    expect(md.content).toContain("# Title");
    expect(md.content).toContain("**bold**");
    const text = buildExport(doc, "text", "final", "Untitled");
    expect(text.fileName).toBe("Untitled.txt");
    expect(text.content).toBe("Title\nSome bold text.\n");
  });
});
