/**
 * New documents: `createDocx` (blank, or from plain paragraphs) and
 * `createDocxFromMarkdown`. Both assemble the package in memory and hand it
 * to the `finish` callback of `DocxFactories.createDocx`, so no await is
 * involved and the result carries the engines of the build.
 */

import type { CreateDocxOptions, DocxDocument } from "../../api/docx.js";
import type { OpcPackage } from "../../api/opc.js";
import { OfficeError } from "../../errors.js";
import { createPackage } from "../../opc/index.js";
import type { DocxFactories } from "../model/document.js";
import { TEXT_WIDTH, documentXml } from "./body-xml.js";
import { type MarkdownImport, parseMarkdown } from "./markdown-blocks.js";
import { type NewBlock, blocksFromParagraphs, cleanFreeText } from "./model.js";
import {
  BULLET_ABSTRACT_ID,
  BULLET_NUM_ID,
  DECIMAL_ABSTRACT_ID,
  DECIMAL_NUM_ID,
  type NumberingInstance,
  appPropertiesXml,
  corePropertiesXml,
  numberingXml,
  settingsXml,
} from "./parts-xml.js";
import { stylesXml } from "./styles-xml.js";

export { type NewBlock, type NewParagraphBlock, type NewRun, type NewTableBlock } from "./model.js";
export { parseMarkdown, type MarkdownImport } from "./markdown-blocks.js";
export { MAX_MARKDOWN_LENGTH } from "./markdown-blocks.js";

/** The `finish` callback of `DocxFactories.createDocx`. */
export type FinishDocument = (pkg: OpcPackage, texts: ReadonlyMap<string, string>) => DocxDocument;

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_PROPERTY_LENGTH = 1024;

/** Re-exported for callers that want the text width of a new document (twips). */
export const NEW_DOCUMENT_TEXT_WIDTH = TEXT_WIDTH;

function checkOptions(options: CreateDocxOptions | undefined): { title?: string; author?: string; date?: string } {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null) throw new OfficeError("invalid_argument", "options must be an object");
  const values: { title?: string; author?: string; date?: string } = {};
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string") throw new OfficeError("invalid_argument", `${name} must be a string`);
    if (value.length > MAX_PROPERTY_LENGTH) throw new OfficeError("invalid_argument", `${name} is too long`);
    return cleanFreeText(value).replace(/\n/g, " ");
  };
  if (options.title !== undefined) values.title = text(options.title, "title");
  if (options.author !== undefined) values.author = text(options.author, "author");
  if (options.date !== undefined) {
    if (typeof options.date !== "string" || !ISO_DATE.test(options.date)) {
      throw new OfficeError("invalid_argument", "date must be an ISO 8601 date or date-time");
    }
    values.date = options.date;
  }
  return values;
}

/** Assembles the package of a new document from its blocks. */
export function assembleDocument(
  blocks: readonly NewBlock[],
  extraNumbering: readonly NumberingInstance[],
  options: CreateDocxOptions | undefined,
  finish: FinishDocument,
): DocxDocument {
  const core = checkOptions(options);
  const pkg = createPackage();
  const texts = new Map<string, string>();
  const put = (name: string, text: string, contentType: string): void => {
    pkg.setPart(name, text, contentType);
    texts.set(name, text);
  };
  const main = "/word/document.xml";
  const links = new Map<string, string>();
  const linkIds: Array<[string, string]> = [];
  let nextId = 10;
  const link = (href: string): string => {
    let id = links.get(href);
    if (id === undefined) {
      id = `rId${nextId++}`;
      links.set(href, id);
      linkIds.push([id, href]);
    }
    return id;
  };
  put(main, documentXml(blocks, link), `${WML}.document.main+xml`);
  pkg.addRelationship("/", { type: `${REL}/officeDocument`, target: "word/document.xml", id: "rId1" });
  put(
    "/docProps/core.xml",
    corePropertiesXml(core),
    "application/vnd.openxmlformats-package.core-properties+xml",
  );
  pkg.addRelationship("/", {
    type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
    target: "docProps/core.xml",
    id: "rId2",
  });
  pkg.setPart("/docProps/app.xml", appPropertiesXml(), "application/vnd.openxmlformats-officedocument.extended-properties+xml");
  pkg.addRelationship("/", { type: `${REL}/extended-properties`, target: "docProps/app.xml", id: "rId3" });

  const numbering: NumberingInstance[] = [
    { numId: DECIMAL_NUM_ID, abstractId: DECIMAL_ABSTRACT_ID },
    { numId: BULLET_NUM_ID, abstractId: BULLET_ABSTRACT_ID },
    ...extraNumbering,
  ];
  put("/word/styles.xml", stylesXml(), `${WML}.styles+xml`);
  pkg.addRelationship(main, { type: `${REL}/styles`, target: "styles.xml", id: "rId1" });
  put("/word/numbering.xml", numberingXml(numbering), `${WML}.numbering+xml`);
  pkg.addRelationship(main, { type: `${REL}/numbering`, target: "numbering.xml", id: "rId2" });
  put("/word/settings.xml", settingsXml(), `${WML}.settings+xml`);
  pkg.addRelationship(main, { type: `${REL}/settings`, target: "settings.xml", id: "rId3" });
  for (const [id, href] of linkIds) {
    pkg.addRelationship(main, { type: `${REL}/hyperlink`, target: href, targetMode: "External", id });
  }
  return finish(pkg, texts);
}

/** Implements `createDocx` (see `DocxFactories.createDocx`). */
export const createDocxFactory: NonNullable<DocxFactories["createDocx"]> = (options, finish) =>
  assembleDocument(blocksFromParagraphs(options?.paragraphs), [], options, finish);

/**
 * A new document from Markdown: ATX and setext headings, paragraphs, bold,
 * italic, strikethrough, inline code, links (`http`, `https`, `mailto` only),
 * ordered and bulleted lists with nesting, block quotes, fenced code and
 * pipe tables. `options.paragraphs` is ignored. Raw HTML stays literal text.
 * Throws `limit_exceeded` above {@link MAX_MARKDOWN_LENGTH} characters.
 */
export function createDocxFromMarkdownWith(
  markdown: string,
  options: Omit<CreateDocxOptions, "paragraphs"> | undefined,
  finish: FinishDocument,
): DocxDocument {
  const parsed: MarkdownImport = parseMarkdown(markdown, BULLET_NUM_ID + 1);
  // Instances of one abstract list share counters, so every list restarts explicitly.
  const extra: NumberingInstance[] = parsed.decimalLists.map((list) => ({
    numId: list.numId,
    abstractId: DECIMAL_ABSTRACT_ID,
    start: list.start,
  }));
  const { paragraphs: _ignored, ...rest } = (options ?? {}) as CreateDocxOptions;
  return assembleDocument(parsed.blocks, extra, rest, finish);
}
