import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import type { OpcPackage } from "../../../../packages/office/src/api/opc.js";
import { openDocx } from "../../../../packages/office/src/docx/index.js";
import { documentFromPackage } from "../../../../packages/office/src/docx/internal.js";
import { createPackage } from "../../../../packages/office/src/opc/index.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";

export const NS =
  `xmlns:w="${W}" xmlns:r="${R}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ` +
  `xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"`;

export interface DocxParts {
  /** Content of `w:body`. */
  body: string;
  /** Children of `w:styles`. */
  styles?: string;
  /** Children of `w:numbering`. */
  numbering?: string;
  /** Children of `w:settings`. */
  settings?: string;
  /** Children of `w:comments`. */
  comments?: string;
  /** Children of `w15:commentsEx`. */
  commentsExtended?: string;
  /** Children of `w:footnotes` / `w:endnotes`. */
  footnotes?: string;
  endnotes?: string;
  /** Relationship id to the content of a `w:hdr` / `w:ftr`. */
  headers?: Record<string, string>;
  footers?: Record<string, string>;
  /** Relationship id to an external hyperlink target. */
  links?: Record<string, string>;
  /** Relationship id to image bytes stored as PNG. */
  images?: Record<string, Uint8Array>;
  /** Replaces the whole main part, for malformed documents. */
  rawDocument?: string;
  mainContentType?: string;
}

const xml = (root: string, content: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${root} ${NS}>${content}</${root.split(" ")[0]}>`;

/** Assembles a minimal word-processing package in memory. */
export function buildPackage(parts: DocxParts): { pkg: OpcPackage; texts: Map<string, string> } {
  const pkg = createPackage();
  const texts = new Map<string, string>();
  const main = "/word/document.xml";
  const put = (name: string, text: string, contentType: string): void => {
    pkg.setPart(name, text, contentType);
    texts.set(name, text);
  };
  put(main, parts.rawDocument ?? xml("w:document", `<w:body>${parts.body}</w:body>`), parts.mainContentType ?? `${TYPE}.document.main+xml`);
  pkg.addRelationship("/", { type: `${REL}/officeDocument`, target: "word/document.xml" });
  const single = (kind: string, root: string, content: string | undefined, type = `${REL}/${kind}`, contentType = `${TYPE}.${kind}+xml`): void => {
    if (content === undefined) return;
    put(`/word/${kind}.xml`, xml(root, content), contentType);
    pkg.addRelationship(main, { type, target: `${kind}.xml` });
  };
  single("styles", "w:styles", parts.styles);
  single("numbering", "w:numbering", parts.numbering);
  single("settings", "w:settings", parts.settings);
  single("comments", "w:comments", parts.comments);
  single(
    "commentsExtended",
    "w15:commentsEx",
    parts.commentsExtended,
    "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
  );
  single("footnotes", "w:footnotes", parts.footnotes);
  single("endnotes", "w:endnotes", parts.endnotes);
  let counter = 0;
  for (const [kind, root, entries] of [
    ["header", "w:hdr", parts.headers ?? {}],
    ["footer", "w:ftr", parts.footers ?? {}],
  ] as const) {
    for (const [id, content] of Object.entries(entries)) {
      counter += 1;
      put(`/word/${kind}${counter}.xml`, xml(root, content), `${TYPE}.${kind}+xml`);
      pkg.addRelationship(main, { type: `${REL}/${kind}`, target: `${kind}${counter}.xml`, id });
    }
  }
  for (const [id, target] of Object.entries(parts.links ?? {})) {
    pkg.addRelationship(main, { type: `${REL}/hyperlink`, target, targetMode: "External", id });
  }
  for (const [id, bytes] of Object.entries(parts.images ?? {})) {
    pkg.setDefaultContentType("png", "image/png");
    pkg.setPart(`/word/media/${id}.png`, bytes);
    pkg.addRelationship(main, { type: `${REL}/image`, target: `media/${id}.png`, id });
  }
  return { pkg, texts };
}

/** A handle on a document assembled in memory, without a ZIP round trip. */
export function buildDocument(parts: DocxParts): DocxDocument {
  const { pkg, texts } = buildPackage(parts);
  return documentFromPackage(pkg, texts);
}

/** The same document after it was saved to bytes and opened again. */
export async function buildAndReopen(parts: DocxParts): Promise<DocxDocument> {
  return openDocx(await buildPackage(parts).pkg.save());
}

/** `<w:p>` with optional properties and runs given as XML. */
export const p = (content: string, properties = ""): string =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}${content}</w:p>`;

/** `<w:r>` with text, and optional run properties. */
export const r = (text: string, properties = ""): string =>
  `<w:r>${properties === "" ? "" : `<w:rPr>${properties}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;

export const cell = (content: string, properties = ""): string =>
  `<w:tc>${properties === "" ? "" : `<w:tcPr>${properties}</w:tcPr>`}${content}</w:tc>`;

export const row = (cells: string, properties = ""): string =>
  `<w:tr>${properties === "" ? "" : `<w:trPr>${properties}</w:trPr>`}${cells}</w:tr>`;

export const tbl = (rows: string, grid = ""): string => `<w:tbl><w:tblPr/><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
