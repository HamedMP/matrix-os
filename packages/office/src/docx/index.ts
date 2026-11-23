/**
 * `.docx` documents: the handle described in `../api/docx.ts`.
 *
 * This file only wires the module together. The document model (opening, the
 * view model, structure helpers, saving, snapshots) lives in `./model/`. The
 * rest of the contract plugs in below: add the function to {@link ENGINES} or
 * {@link FACTORIES} and import it from the module that implements it.
 * Everything those modules build on is exported from `./internal.ts`.
 */

import type { DocxModule } from "../api/docx.js";
import { OfficeError } from "../errors.js";
import type { DocxEngines, DocxFactories } from "./model/document.js";
import { documentFromPackage, openDocxWith } from "./model/open.js";

export type * from "../api/docx.js";

/**
 * The engines behind `applyOps`, `acceptRevisions` and `rejectRevisions`:
 * functions of the document's `DocxIndex` (see `DocxEngines`). A method whose
 * engine is absent throws `invalid_operation`.
 */
const ENGINES: DocxEngines = {};

/** The implementations of `createDocx` and `compareDocx` (see `DocxFactories`). */
const FACTORIES: DocxFactories = {};

export const openDocx: DocxModule["openDocx"] = (bytes, limits) => openDocxWith(ENGINES, bytes, limits);

export const createDocx: DocxModule["createDocx"] = (options) => {
  const create = FACTORIES.createDocx;
  if (create === undefined) {
    throw new OfficeError("invalid_operation", "document creation is not part of this build");
  }
  return create(options, (pkg, texts) => documentFromPackage(pkg, texts, ENGINES));
};

export const compareDocx: DocxModule["compareDocx"] = (original, revised, options) => {
  const compare = FACTORIES.compareDocx;
  if (compare === undefined) {
    return Promise.reject(new OfficeError("invalid_operation", "document comparison is not part of this build"));
  }
  return compare(original, revised, options, openDocx);
};

import { compareDocuments, compareDocumentsDetailed } from "./compare/index.js";
import type { CompareDetailedOptions, CompareResult } from "./compare/index.js";

FACTORIES.compareDocx = compareDocuments;

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

export type {
  ChangeClassification,
  CompareChange,
  CompareDetailedOptions,
  CompareExpectation,
  CompareResult,
  CompareSummary,
} from "./compare/index.js";
