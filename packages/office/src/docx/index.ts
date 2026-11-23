/**
 * `.docx` documents: the handle described in `../api/docx.ts`.
 *
 * This file only wires the module together. The document model (opening, the
 * view model, structure helpers, saving, snapshots) lives in `./model/`; the
 * other parts of the contract plug in through {@link ENGINES} and the two
 * factories below. Everything they build on is exported from `./internal.ts`.
 */

import type { DocxDocument, DocxModule } from "../api/docx.js";
import { OfficeError } from "../errors.js";
import type { DocxEngines } from "./model/document.js";
import { openDocxWith } from "./model/open.js";

export type * from "../api/docx.js";

/**
 * The engines behind `applyOps`, `acceptRevisions` and `rejectRevisions`.
 * Each is a function of the document's `DocxIndex`; see `DocxEngines` in
 * `./internal.ts`. A method whose engine is absent throws `invalid_operation`.
 */
const ENGINES: DocxEngines = {};

/** `createDocx` and `compareDocx`, supplied by the modules that implement them. */
const FACTORIES: { createDocx?: DocxModule["createDocx"]; compareDocx?: DocxModule["compareDocx"] } = {};

export const openDocx: DocxModule["openDocx"] = (bytes, limits) => openDocxWith(ENGINES, bytes, limits);

export const createDocx: DocxModule["createDocx"] = (options): DocxDocument => {
  if (FACTORIES.createDocx === undefined) {
    throw new OfficeError("invalid_operation", "document creation is not part of this build");
  }
  return FACTORIES.createDocx(options);
};

export const compareDocx: DocxModule["compareDocx"] = (original, revised, options) => {
  if (FACTORIES.compareDocx === undefined) {
    return Promise.reject(new OfficeError("invalid_operation", "document comparison is not part of this build"));
  }
  return FACTORIES.compareDocx(original, revised, options);
};
