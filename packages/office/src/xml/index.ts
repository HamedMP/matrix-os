/**
 * Lossless XML tree for office document parts.
 *
 * `serializeXml(parseXml(text)) === text` for every document the parser
 * accepts. No DTD, no entity expansion, bounded depth and node count.
 * The contract and its rules are in `../api/xml.ts`.
 */

import type { XmlModule } from "../api/xml.js";
import { escapeXmlAttr, escapeXmlText } from "./escape.js";
import {
  appendChild,
  cloneDocument,
  cloneNode,
  createElement,
  createText,
  insertAfter,
  insertBefore,
  prependChild,
  remove,
  removeAttr,
  replaceNode,
  setAttr,
  setText,
  setTextContent,
} from "./mutate.js";
import { localName, lookupNamespace, lookupPrefix, namespaceOf, prefixOf } from "./names.js";
import { DEFAULT_XML_LIMITS, parseXml } from "./parser.js";
import { child, children, find, findAll, getAttr, isWhitespaceText, textContent } from "./query.js";
import { serializeXml } from "./serializer.js";

export type * from "../api/xml.js";
export { XML_NAMESPACE, XMLNS_NAMESPACE } from "./names.js";
export { isXmlName } from "./chars.js";

export {
  DEFAULT_XML_LIMITS,
  appendChild,
  child,
  children,
  cloneDocument,
  cloneNode,
  createElement,
  createText,
  escapeXmlAttr,
  escapeXmlText,
  find,
  findAll,
  getAttr,
  insertAfter,
  insertBefore,
  isWhitespaceText,
  localName,
  lookupNamespace,
  lookupPrefix,
  namespaceOf,
  parseXml,
  prefixOf,
  prependChild,
  remove,
  removeAttr,
  replaceNode,
  serializeXml,
  setAttr,
  setText,
  setTextContent,
  textContent,
};

/** Every contract export as one object; also the compile-time proof that the module is complete. */
export const xmlModule: XmlModule = Object.freeze({
  parseXml,
  serializeXml,
  child,
  children,
  find,
  findAll,
  getAttr,
  setAttr,
  removeAttr,
  createElement,
  createText,
  appendChild,
  prependChild,
  insertBefore,
  insertAfter,
  remove,
  replaceNode,
  cloneNode,
  cloneDocument,
  textContent,
  setTextContent,
  setText,
  isWhitespaceText,
  localName,
  prefixOf,
  lookupNamespace,
  escapeXmlText,
  escapeXmlAttr,
  DEFAULT_XML_LIMITS,
});
