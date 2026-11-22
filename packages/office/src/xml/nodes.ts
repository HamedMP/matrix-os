/**
 * Writable views of the contract's node types, for use inside this module
 * only. The public types are `readonly`; the parser and the mutation helpers
 * are the only code that writes fields, and they do it through these views.
 */

import type {
  XmlAttr,
  XmlCData,
  XmlChildNode,
  XmlComment,
  XmlDeclaration,
  XmlDocument,
  XmlElement,
  XmlNode,
  XmlProcessingInstruction,
  XmlText,
} from "../api/xml.js";

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export type WritableAttr = Writable<XmlAttr>;
export type WritableText = Writable<XmlText>;
export type WritableCData = Writable<XmlCData>;
export type WritableComment = Writable<XmlComment>;
export type WritableProcessingInstruction = Writable<XmlProcessingInstruction>;
export type WritableDeclaration = Writable<XmlDeclaration>;

export interface WritableElement extends Omit<Writable<XmlElement>, "attrs" | "children"> {
  attrs: XmlAttr[];
  children: XmlChildNode[];
}

export interface WritableDocument extends Omit<Writable<XmlDocument>, "children"> {
  children: XmlNode[];
}

/** Any node whose `parent` field can be rewritten. */
export type WritableChild = Writable<XmlChildNode>;

export function writableElement(element: XmlElement): WritableElement {
  return element as WritableElement;
}

export function writableAttr(attr: XmlAttr): WritableAttr {
  return attr as WritableAttr;
}

/** Sets the parent link of any child node. */
export function setParent(node: XmlChildNode, parent: XmlElement | XmlDocument | null): void {
  (node as { parent: XmlElement | XmlDocument | null }).parent = parent;
}
