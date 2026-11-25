/**
 * `.docx` documents: the handle described in `../api/docx.ts`.
 *
 * This file wires the module together:
 *
 * - `./model/`: opening, the view model, structure helpers, saving, snapshots
 * - `./edit/`: `applyOps`, directly or as native tracked revisions
 * - `./comments/`: comment threads
 * - `./revisions/`: accepting and rejecting revisions
 * - `./create/`: new documents, from paragraphs or Markdown
 * - `./compare/`: comparing two versions into tracked revisions
 * - `./export/`: HTML, Markdown and plain text
 *
 * The handle gets editing and revision resolution as engines (`DocxEngines`),
 * and the modules that make handles (`create`, `compare`) get what they need
 * as arguments, so none of them imports this file. Everything they build on
 * is exported from `./internal.ts`.
 */

import type { CreateDocxOptions, DocxDocument, DocxModule } from "../api/docx.js";
import type { OpcPackage } from "../api/opc.js";
import { compareDocuments, compareDocumentsDetailed } from "./compare/index.js";
import type { CompareDetailedOptions, CompareResult } from "./compare/index.js";
import { createDocxFactory, createDocxFromMarkdownWith } from "./create/index.js";
import { applyOps } from "./edit/index.js";
import type { DocxEngines } from "./model/document.js";
import type { DocxOpenLimits } from "./model/limits.js";
import { documentFromPackage, openDocxWith } from "./model/open.js";
import { acceptRevisions, rejectRevisions } from "./revisions/index.js";

export type * from "../api/docx.js";
export type {
  ChangeClassification,
  CompareChange,
  CompareDetailedOptions,
  CompareExpectation,
  CompareResult,
  CompareSummary,
} from "./compare/index.js";
export { DEFAULT_DOCX_LIMITS } from "./model/limits.js";
export type { DocxLimits, DocxOpenLimits } from "./model/limits.js";
export { toHtml, toMarkdown, toPlainText } from "./export/index.js";
export type { HtmlExportMode, HtmlExportOptions, MarkdownExportOptions, PlainTextExportOptions } from "./export/index.js";

/** The engines behind `applyOps`, `acceptRevisions` and `rejectRevisions` of every handle this module makes. */
const ENGINES: DocxEngines = Object.freeze({ applyOps, acceptRevisions, rejectRevisions });

/** Makes the handle of a package assembled in memory; `texts` holds the XML text of the model parts by part name. */
const finish = (pkg: OpcPackage, texts: ReadonlyMap<string, string>): DocxDocument => documentFromPackage(pkg, texts, ENGINES);

/**
 * Opens a document. `limits` takes the ZIP limits and the document limits
 * (`DEFAULT_DOCX_LIMITS`) in one object; a file that passes one is refused
 * with `zip_limit_exceeded` or `limit_exceeded`.
 */
export const openDocx = (bytes: Uint8Array, limits?: DocxOpenLimits): Promise<DocxDocument> => openDocxWith(ENGINES, bytes, limits);

export const createDocx: DocxModule["createDocx"] = (options) => createDocxFactory(options, finish);

export const compareDocx: DocxModule["compareDocx"] = (original, revised, options) => compareDocuments(original, revised, options, openDocx);

/**
 * `compareDocx` with a summary of the revisions it wrote (counts by kind and
 * a substantive or formatting-only classification of every change) and the
 * texts its self-check held the result to.
 */
export const compareDocxDetailed = (
  original: Parameters<DocxModule["compareDocx"]>[0],
  revised: Parameters<DocxModule["compareDocx"]>[1],
  options: CompareDetailedOptions,
): Promise<CompareResult> => compareDocumentsDetailed(original, revised, options, openDocx);

/**
 * Creates a document from Markdown: headings, paragraphs, bold, italic,
 * strikethrough, inline code, links, nested lists, block quotes, fenced code
 * and pipe tables. Raw HTML stays literal text.
 */
export const createDocxFromMarkdown = (markdown: string, options?: Omit<CreateDocxOptions, "paragraphs">): DocxDocument =>
  createDocxFromMarkdownWith(markdown, options, finish);

/** Every contract export as one object; also the compile-time proof that the module is complete. */
export const docxModule: DocxModule = Object.freeze({ openDocx, createDocx, compareDocx });
