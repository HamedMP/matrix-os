import { readFileSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import type { DocxDocument, Revision } from "../../../../packages/office/src/api/docx.js";
import { compareDocx, openDocx } from "../../../../packages/office/src/docx/index.js";
import { createPackage, openPackage } from "../../../../packages/office/src/opc/index.js";
import { getAttr, insertBefore, parseXml, remove, textContent } from "../../../../packages/office/src/xml/index.js";

export const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures");
export const AUTHOR = "Dana Reviewer";
export const DATE = "2027-02-01T10:00:00Z";
export const OPTIONS = { author: AUTHOR, date: DATE } as const;

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const NS = `xmlns:w="${W}" xmlns:r="${R}"`;

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

export function expectedText(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, "expected", name), "utf8");
}

export interface Parts {
  /** Content of `w:body`, without the section properties. */
  body: string;
  /** Children of `w:styles`. */
  styles?: string;
  /** Normal footnotes: `w:id` to the content of the `w:footnote`. */
  footnotes?: Record<string, string>;
  /** Normal endnotes: `w:id` to the content of the `w:endnote`. */
  endnotes?: Record<string, string>;
  /** Content of the default header. */
  header?: string;
  /** Relationship id to external hyperlink target. */
  links?: Record<string, string>;
  /** Relationship id to PNG bytes. */
  images?: Record<string, Uint8Array>;
}

const part = (root: string, content: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${root} ${NS}>${content}</${root}>`;

/** Assembles a small word-processing package and returns its bytes. */
export async function buildDocx(parts: Parts): Promise<Uint8Array> {
  const pkg = createPackage();
  const main = "/word/document.xml";
  const headerReference = parts.header === undefined ? "" : `<w:headerReference w:type="default" r:id="rIdHeader"/>`;
  const sectPr = `<w:sectPr>${headerReference}<w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`;
  pkg.setPart(main, part("w:document", `<w:body>${parts.body}${sectPr}</w:body>`), `${TYPE}.document.main+xml`);
  pkg.addRelationship("/", { type: `${R}/officeDocument`, target: "word/document.xml" });
  if (parts.styles !== undefined) {
    pkg.setPart("/word/styles.xml", part("w:styles", parts.styles), `${TYPE}.styles+xml`);
    pkg.addRelationship(main, { type: `${R}/styles`, target: "styles.xml" });
  }
  if (parts.footnotes !== undefined) {
    const separators =
      `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
      `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`;
    const notes = Object.entries(parts.footnotes)
      .map(([id, content]) => `<w:footnote w:id="${id}">${content}</w:footnote>`)
      .join("");
    pkg.setPart("/word/footnotes.xml", part("w:footnotes", separators + notes), `${TYPE}.footnotes+xml`);
    pkg.addRelationship(main, { type: `${R}/footnotes`, target: "footnotes.xml" });
  }
  if (parts.endnotes !== undefined) {
    const separators =
      `<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>` +
      `<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>`;
    const notes = Object.entries(parts.endnotes)
      .map(([id, content]) => `<w:endnote w:id="${id}">${content}</w:endnote>`)
      .join("");
    pkg.setPart("/word/endnotes.xml", part("w:endnotes", separators + notes), `${TYPE}.endnotes+xml`);
    pkg.addRelationship(main, { type: `${R}/endnotes`, target: "endnotes.xml" });
  }
  if (parts.header !== undefined) {
    pkg.setPart("/word/header1.xml", part("w:hdr", parts.header), `${TYPE}.header+xml`);
    pkg.addRelationship(main, { type: `${R}/header`, target: "header1.xml", id: "rIdHeader" });
  }
  for (const [id, target] of Object.entries(parts.links ?? {})) {
    pkg.addRelationship(main, { type: `${R}/hyperlink`, target, targetMode: "External", id });
  }
  for (const [id, bytes] of Object.entries(parts.images ?? {})) {
    pkg.setDefaultContentType("png", "image/png");
    pkg.setPart(`/word/media/${id}.png`, bytes);
    pkg.addRelationship(main, { type: `${R}/image`, target: `media/${id}.png`, id });
  }
  return pkg.save();
}

/** A document whose body is the given paragraphs of plain text. */
export function bodyOf(...paragraphs: string[]): Promise<Uint8Array> {
  return buildDocx({ body: paragraphs.map((text) => p(r(text))).join("") });
}

export const p = (content: string, properties = ""): string =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}${content}</w:p>`;

export const r = (text: string, properties = ""): string =>
  `<w:r>${properties === "" ? "" : `<w:rPr>${properties}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;

export const cell = (content: string): string => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${content}</w:tc>`;

export const row = (...cells: string[]): string => `<w:tr>${cells.join("")}</w:tr>`;

export const tbl = (...rows: string[]): string =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>${rows.join("")}</w:tbl>`;

/** A table of plain text cells. */
export const textTable = (...rows: string[][]): string => tbl(...rows.map((cells) => row(...cells.map((text) => cell(p(r(text)))))));

export const footnoteRef = (id: string): string =>
  `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;

export const footnoteBody = (text: string): string => p(`<w:r><w:footnoteRef/></w:r>${r(` ${text}`)}`);

/** Body text in the three views. */
export function views(document: DocxDocument): { final: string; original: string; markup: string } {
  return {
    final: document.getPlainText({ view: "final" }),
    original: document.getPlainText({ view: "original" }),
    markup: document.getPlainText({ view: "markup" }),
  };
}

export async function textOf(bytes: Uint8Array): Promise<string> {
  return (await openDocx(bytes)).getPlainText();
}

/** `[kind, scope, text]` of every revision, in document order. */
export function describeRevisions(document: DocxDocument): Array<[string, string, string]> {
  return document.listRevisions().map((revision: Revision) => [revision.kind, revision.scope, revision.text]);
}

/** Saves and reopens, so a test also covers what reaches the file. */
export async function reopen(document: DocxDocument): Promise<DocxDocument> {
  return openDocx(await document.save());
}

/*
 * An independent accept-all / reject-all over the saved main part, following
 * the rules of `tests/office/tools/accept_all.py` (with table cells read like
 * the body, so that paragraph marks inside a cell join too). It shares no
 * code with the comparison: it reads the XML of the file that was written.
 */

type Node = ReturnType<typeof parseXml>["root"];

const elements = (parent: Node): Node[] => parent.children.filter((node): node is Node => node.kind === "element");

function descendants(root: Node, name: string): Node[] {
  const found: Node[] = [];
  const visit = (element: Node): void => {
    for (const node of elements(element)) {
      if (node.name === name) found.push(node);
      visit(node);
    }
  };
  visit(root);
  return found;
}

const parentElement = (node: Node): Node | null => (node.parent !== null && node.parent.kind === "element" ? node.parent : null);

const isMark = (node: Node): boolean => parentElement(node)?.name === "w:rPr" && parentElement(parentElement(node) as Node)?.name === "w:pPr";

const isRowMark = (node: Node): boolean => parentElement(node)?.name === "w:trPr";

function resolveBody(body: Node, accept: boolean): Set<Node> {
  const joining = new Set<Node>();
  const drop = accept ? ["w:del", "w:moveFrom"] : ["w:ins", "w:moveTo"];
  const keep = accept ? ["w:ins", "w:moveTo"] : ["w:del", "w:moveFrom"];
  for (const name of drop) {
    for (const node of descendants(body, name)) {
      if (isMark(node)) joining.add(parentElement(parentElement(parentElement(node) as Node) as Node) as Node);
      if (isRowMark(node)) remove(parentElement(parentElement(node) as Node) as Node);
      else remove(node);
    }
  }
  for (const name of keep) {
    for (const node of descendants(body, name)) {
      if (!isMark(node) && !isRowMark(node)) for (const inner of [...node.children]) insertBefore(node, inner);
      remove(node);
    }
  }
  return joining;
}

function runText(paragraph: Node, deletedTextVisible: boolean): string {
  let text = "";
  const hidden: boolean[] = [];
  const visit = (parent: Node): void => {
    for (const node of elements(parent)) {
      const name = node.name;
      if (name === "w:pPr" || name === "w:rPr" || name === "w:instrText" || name === "w:delInstrText" || name === "mc:Fallback") continue;
      if (name === "w:fldChar") {
        const type = getAttr(node, "w:fldCharType");
        if (type === "begin") hidden.push(true);
        else if (type === "separate" && hidden.length > 0) hidden[hidden.length - 1] = false;
        else if (type === "end") hidden.pop();
        continue;
      }
      if (hidden.includes(true)) visit(node);
      else if (name === "w:t" || (name === "w:delText" && deletedTextVisible)) text += textContent(node);
      else if (name === "w:delText") continue;
      else if (name === "w:tab") text += "\t";
      else if (name === "w:br" || name === "w:cr") text += "\n";
      else if (name === "w:noBreakHyphen") text += "‑";
      else if (name === "w:softHyphen") continue;
      else visit(node);
    }
  };
  visit(paragraph);
  return text;
}

/** Child blocks of a container, looking through block-level content controls. */
function blocksOf(container: Node): Node[] {
  return elements(container).flatMap((node) =>
    node.name === "w:sdt" || node.name === "w:sdtContent" || node.name === "w:customXml" ? blocksOf(node) : [node],
  );
}

function blockLines(container: Node, joining: ReadonlySet<Node>, reject: boolean): string[] {
  const lines: string[] = [];
  let pending = "";
  for (const block of blocksOf(container)) {
    if (block.name === "w:p") {
      const text = pending + runText(block, reject);
      if (joining.has(block)) {
        pending = text;
        continue;
      }
      pending = "";
      lines.push(text);
    } else if (block.name === "w:tbl") {
      if (pending !== "") lines.push(pending);
      pending = "";
      for (const row of elements(block).filter((node) => node.name === "w:tr")) {
        const cells = elements(row).filter((node) => node.name === "w:tc");
        lines.push(cells.map((cell) => blockLines(cell, joining, reject).join("\n")).join("\t"));
      }
    }
  }
  if (pending !== "") lines.push(pending);
  return lines;
}

/** Body text of a saved document after accepting or rejecting every tracked change, one line per paragraph or row. */
export async function resolvedText(bytes: Uint8Array, mode: "accept" | "reject"): Promise<string> {
  const pkg = await openPackage(bytes);
  const root = parseXml(await pkg.getPartText("/word/document.xml")).root;
  const body = elements(root).find((node) => node.name === "w:body");
  if (body === undefined) throw new Error("no body");
  const joining = resolveBody(body, mode === "accept");
  return blockLines(body, joining, mode === "reject").join("\n");
}

/**
 * Accepting everything in the written file gives the revised body and
 * rejecting everything the original, by the independent reading above.
 */
export async function expectResolves(document: DocxDocument, original: Uint8Array, revised: Uint8Array): Promise<void> {
  const written = await document.save();
  expect(await resolvedText(written, "accept")).toBe(await resolvedText(revised, "accept"));
  expect(await resolvedText(written, "reject")).toBe(await resolvedText(original, "accept"));
}

/** Compares, checks both views against the inputs (in memory, after a save, and independently), and returns the result. */
export async function compared(original: Uint8Array, revised: Uint8Array): Promise<DocxDocument> {
  const document = await compareDocx(original, revised, OPTIONS);
  const expected = { final: await textOf(revised), original: await textOf(original) };
  expect({ final: views(document).final, original: views(document).original }).toEqual(expected);
  const saved = await reopen(document);
  expect({ final: views(saved).final, original: views(saved).original }).toEqual(expected);
  for (const revision of saved.listRevisions()) {
    expect([revision.author, revision.date]).toEqual([AUTHOR, DATE]);
  }
  await expectResolves(document, original, revised);
  return document;
}
