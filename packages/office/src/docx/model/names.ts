/**
 * Vocabulary of a word-processing package: relationship types, content types,
 * the kinds of part the model parses, and small readers shared by every file
 * in this folder.
 *
 * Element and attribute names are matched as written with the conventional
 * prefixes (`w:`, `w14:`, `w15:`, `r:`), which every producer uses.
 */

import type { XmlChildNode, XmlElement } from "../../api/xml.js";

const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const OFFICE_REL_STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const WORD_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";

/** Parts with a single instance per document that the model understands. */
export type DocxPartKind =
  | "document"
  | "styles"
  | "numbering"
  | "settings"
  | "comments"
  | "commentsExtended"
  | "footnotes"
  | "endnotes"
  | "theme"
  | "coreProperties";

/** Every kind of part, headers and footers (many per document) included. */
export type DocxSlotKind = DocxPartKind | "header" | "footer";

export interface PartKindInfo {
  /** Relationship types that point at the part, preferred form first. */
  readonly relationshipTypes: readonly string[];
  readonly contentType: string;
  /** Part name used when the model has to create the part. */
  readonly defaultName: string;
}

export const PART_KINDS: Readonly<Record<Exclude<DocxSlotKind, "document">, PartKindInfo>> = {
  styles: {
    relationshipTypes: [`${OFFICE_REL}/styles`, `${OFFICE_REL_STRICT}/styles`],
    contentType: `${WORD_TYPE}.styles+xml`,
    defaultName: "/word/styles.xml",
  },
  numbering: {
    relationshipTypes: [`${OFFICE_REL}/numbering`, `${OFFICE_REL_STRICT}/numbering`],
    contentType: `${WORD_TYPE}.numbering+xml`,
    defaultName: "/word/numbering.xml",
  },
  settings: {
    relationshipTypes: [`${OFFICE_REL}/settings`, `${OFFICE_REL_STRICT}/settings`],
    contentType: `${WORD_TYPE}.settings+xml`,
    defaultName: "/word/settings.xml",
  },
  comments: {
    relationshipTypes: [`${OFFICE_REL}/comments`, `${OFFICE_REL_STRICT}/comments`],
    contentType: `${WORD_TYPE}.comments+xml`,
    defaultName: "/word/comments.xml",
  },
  commentsExtended: {
    relationshipTypes: ["http://schemas.microsoft.com/office/2011/relationships/commentsExtended"],
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    defaultName: "/word/commentsExtended.xml",
  },
  footnotes: {
    relationshipTypes: [`${OFFICE_REL}/footnotes`, `${OFFICE_REL_STRICT}/footnotes`],
    contentType: `${WORD_TYPE}.footnotes+xml`,
    defaultName: "/word/footnotes.xml",
  },
  endnotes: {
    relationshipTypes: [`${OFFICE_REL}/endnotes`, `${OFFICE_REL_STRICT}/endnotes`],
    contentType: `${WORD_TYPE}.endnotes+xml`,
    defaultName: "/word/endnotes.xml",
  },
  theme: {
    relationshipTypes: [`${OFFICE_REL}/theme`, `${OFFICE_REL_STRICT}/theme`],
    contentType: "application/vnd.openxmlformats-officedocument.theme+xml",
    defaultName: "/word/theme/theme1.xml",
  },
  coreProperties: {
    relationshipTypes: [
      "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
      "http://purl.oclc.org/ooxml/officeDocument/relationships/metadata/core-properties",
    ],
    contentType: "application/vnd.openxmlformats-package.core-properties+xml",
    defaultName: "/docProps/core.xml",
  },
  header: {
    relationshipTypes: [`${OFFICE_REL}/header`, `${OFFICE_REL_STRICT}/header`],
    contentType: `${WORD_TYPE}.header+xml`,
    defaultName: "/word/header1.xml",
  },
  footer: {
    relationshipTypes: [`${OFFICE_REL}/footer`, `${OFFICE_REL_STRICT}/footer`],
    contentType: `${WORD_TYPE}.footer+xml`,
    defaultName: "/word/footer1.xml",
  },
};

export const HYPERLINK_RELATIONSHIP_TYPES: readonly string[] = [
  `${OFFICE_REL}/hyperlink`,
  `${OFFICE_REL_STRICT}/hyperlink`,
];

/** Namespace declarations for a part the model creates from nothing. */
export const WORD_NAMESPACES: ReadonlyArray<readonly [string, string]> = [
  ["xmlns:w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"],
  ["xmlns:r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"],
  ["xmlns:mc", "http://schemas.openxmlformats.org/markup-compatibility/2006"],
  ["xmlns:w14", "http://schemas.microsoft.com/office/word/2010/wordml"],
  ["xmlns:w15", "http://schemas.microsoft.com/office/word/2012/wordml"],
];

/** True for a main part content type of a word-processing document or template. */
export function isWordMainContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return (
    contentType.startsWith("application/vnd.openxmlformats-officedocument.wordprocessingml.") ||
    contentType.startsWith("application/vnd.ms-word.")
  );
}

/** Content revision containers: their content is one tracked insertion, deletion or move. */
export const REVISION_CONTAINERS: ReadonlySet<string> = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo"]);

/** Inline wrappers that do not change the text they contain. */
export const TRANSPARENT_INLINE: ReadonlySet<string> = new Set([
  "w:smartTag",
  "w:customXml",
  "w:sdt",
  "w:sdtContent",
  "w:dir",
  "w:bdo",
]);

/** Block wrappers whose children are blocks of the enclosing container. */
export const TRANSPARENT_BLOCK: ReadonlySet<string> = new Set(["w:sdt", "w:sdtContent", "w:customXml"]);

/** Child elements of an element, without allocating for the non-element nodes. */
export function elementChildren(parent: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  const nodes = parent.children;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as XmlChildNode;
    if (node.kind === "element") found.push(node);
  }
  return found;
}

export function firstChild(parent: XmlElement, name: string): XmlElement | null {
  const nodes = parent.children;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as XmlChildNode;
    if (node.kind === "element" && node.name === name) return node;
  }
  return null;
}

export function attr(element: XmlElement, name: string): string | null {
  const attrs = element.attrs;
  for (let index = 0; index < attrs.length; index++) {
    const entry = attrs[index];
    if (entry !== undefined && entry.name === name) return entry.value;
  }
  return null;
}

/** `w:val` of the named child, or null when the child or the attribute is absent. */
export function childVal(parent: XmlElement, name: string): string | null {
  const element = firstChild(parent, name);
  return element === null ? null : attr(element, "w:val");
}

/**
 * An on/off property (`w:b`, `w:keepNext`): null when the child is absent,
 * false for `0`, `false` and `off`, true otherwise.
 */
export function childToggle(parent: XmlElement, name: string): boolean | null {
  const element = firstChild(parent, name);
  if (element === null) return null;
  return isOn(attr(element, "w:val"));
}

/** Reads an on/off attribute value; an absent value means on. */
export function isOn(value: string | null): boolean {
  return !(value === "0" || value === "false" || value === "off");
}

/** A base-10 integer attribute, or null when absent or not a number. */
export function intAttr(element: XmlElement, name: string): number | null {
  const value = attr(element, name);
  if (value === null || !/^-?\d+$/.test(value.trim())) return null;
  return Number.parseInt(value, 10);
}

/** Twentieths of a point to points. */
export function twipsToPt(value: number): number {
  return value / 20;
}

/** The nearest ancestor (or the element itself) with the given name. */
export function closest(element: XmlElement, name: string): XmlElement | null {
  let scope: XmlElement["parent"] = element;
  while (scope !== null && scope.kind === "element") {
    if (scope.name === name) return scope;
    scope = scope.parent;
  }
  return null;
}

/** The nearest strict ancestor with the given name. */
export function ancestor(element: XmlElement, name: string): XmlElement | null {
  const parent = element.parent;
  return parent !== null && parent.kind === "element" ? closest(parent, name) : null;
}
