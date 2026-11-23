/** Opening a `.docx`: package, part texts, index, handle. */

import type { DocxDocument } from "../../api/docx.js";
import type { OpcPackage, ZipLimits } from "../../api/opc.js";
import { openPackage, partNameKey } from "../../opc/index.js";
import { DocxIndex } from "./doc-index.js";
import { type DocxEngines, createDocumentHandle } from "./document.js";
import { discoverParts } from "./parts.js";

/** Reads the text of every part the model parses. */
export async function readPartTexts(pkg: OpcPackage): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const part of discoverParts(pkg)) {
    texts.set(partNameKey(part.name), await pkg.getPartText(part.name));
  }
  return texts;
}

/**
 * Builds a handle on a package whose model parts are given as text, without
 * awaiting anything: for a document that was just assembled in memory.
 * `texts` maps a part name (any spelling `partNameKey` accepts) to its XML.
 */
export function documentFromPackage(
  pkg: OpcPackage,
  texts: ReadonlyMap<string, string>,
  engines: DocxEngines = {},
): DocxDocument {
  const keyed = new Map<string, string>();
  for (const [name, text] of texts) keyed.set(partNameKey(name), text);
  return createDocumentHandle(new DocxIndex(pkg, keyed), engines);
}

/** Opens a document with the given engines behind its editing methods. */
export async function openDocxWith(
  engines: DocxEngines,
  bytes: Uint8Array,
  limits?: Partial<ZipLimits>,
): Promise<DocxDocument> {
  const pkg = await openPackage(bytes, limits);
  return createDocumentHandle(new DocxIndex(pkg, await readPartTexts(pkg)), engines);
}
