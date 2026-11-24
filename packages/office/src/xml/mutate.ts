/**
 * The only code that changes a tree after parsing. Each helper keeps the
 * `parent` links consistent and clears the source spelling (`raw`) of exactly
 * the value it changes, so the serialiser rewrites that value and nothing else.
 */

import type {
  AppendChild,
  CloneDocument,
  CloneNode,
  CreateElement,
  CreateText,
  InsertAfter,
  InsertBefore,
  PrependChild,
  Remove,
  RemoveAttr,
  ReplaceNode,
  SetAttr,
  SetText,
  SetTextContent,
  XmlAttr,
  XmlChildNode,
  XmlDocument,
  XmlElement,
  XmlNode,
} from "../api/xml.js";
import { isXmlName } from "./chars.js";
import { invalidArgument, invalidOperation, quoteName } from "./errors.js";
import {
  type WritableDocument,
  type WritableElement,
  type WritableText,
  setParent,
  writableAttr,
  writableElement,
} from "./nodes.js";

function requireString(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string") throw invalidArgument(`${what} must be a string`);
}

function requireName(name: unknown, what: string): asserts name is string {
  if (typeof name !== "string" || !isXmlName(name)) {
    throw invalidArgument(`${what} is not a valid XML name: ${typeof name === "string" ? quoteName(name) : typeof name}`);
  }
}

function requireChildNode(node: XmlChildNode): void {
  const kind: unknown = (node as { kind?: unknown } | null)?.kind;
  if (kind !== "element" && kind !== "text" && kind !== "cdata" && kind !== "comment" && kind !== "pi") {
    throw invalidArgument("expected an element, text, CDATA, comment or processing instruction node");
  }
}

function requireElement(element: XmlElement): void {
  if ((element as { kind?: unknown } | null)?.kind !== "element") throw invalidArgument("expected an element");
}

function newAttr(name: string, value: string): XmlAttr {
  return { name, value, raw: null, quote: '"', lead: " ", eq: "=" };
}

export const setAttr: SetAttr = (element, name, value) => {
  requireElement(element);
  requireName(name, "attribute name");
  requireString(value, "attribute value");
  const attrs = writableElement(element).attrs;
  for (let index = 0; index < attrs.length; index++) {
    const attr = attrs[index] as XmlAttr;
    if (attr.name === name) {
      const target = writableAttr(attr);
      target.value = value;
      target.raw = null;
      return;
    }
  }
  attrs.push(newAttr(name, value));
};

export const removeAttr: RemoveAttr = (element, name) => {
  const attrs = writableElement(element).attrs;
  for (let index = 0; index < attrs.length; index++) {
    if ((attrs[index] as XmlAttr).name === name) {
      attrs.splice(index, 1);
      return true;
    }
  }
  return false;
};

export const createText: CreateText = (value) => {
  requireString(value, "text");
  return { kind: "text", value, raw: null, parent: null };
};

export const createElement: CreateElement = (name, attrs, children) => {
  requireName(name, "element name");
  const list: XmlAttr[] = [];
  if (attrs !== undefined && attrs !== null) {
    const pairs: ReadonlyArray<readonly [string, string]> = Array.isArray(attrs)
      ? (attrs as ReadonlyArray<readonly [string, string]>)
      : Object.entries(attrs as Readonly<Record<string, string>>);
    for (const pair of pairs) {
      const attrName: unknown = pair[0];
      const attrValue: unknown = pair[1];
      requireName(attrName, "attribute name");
      requireString(attrValue, "attribute value");
      for (const existing of list) {
        if (existing.name === attrName) throw invalidArgument(`duplicate attribute ${quoteName(attrName)}`);
      }
      list.push(newAttr(attrName, attrValue));
    }
  }
  const element: WritableElement = {
    kind: "element",
    name,
    attrs: list,
    children: [],
    parent: null,
    selfClosing: true,
    openTagTail: "",
    closeTagTail: "",
  };
  if (children !== undefined && children !== null) {
    for (const entry of children) {
      if (typeof entry === "string") {
        if (entry !== "") element.children.push({ kind: "text", value: entry, raw: null, parent: element });
      } else {
        appendChild(element, entry);
      }
    }
  }
  return element;
};

/** Throws when putting `node` under `parent` would make it its own ancestor. */
function refuseCycle(parent: XmlElement, node: XmlChildNode): void {
  if (node.kind !== "element") return;
  let scope: XmlElement | XmlDocument | null = parent;
  while (scope !== null && scope.kind === "element") {
    if (scope === node) throw invalidOperation("a node cannot be inserted into its own subtree");
    scope = scope.parent;
  }
}

/** Takes a node out of its parent's child list. The document element stays where it is. */
function detach(node: XmlChildNode): void {
  const parent = node.parent;
  if (parent === null) return;
  if (parent.kind === "document" && parent.root === node) {
    throw invalidOperation("the document element cannot be removed from its document");
  }
  const siblings = parent.children as XmlNode[];
  // Edits cluster at the end of long child lists far more often than at the start.
  const index = siblings[siblings.length - 1] === node ? siblings.length - 1 : siblings.indexOf(node);
  if (index !== -1) siblings.splice(index, 1);
  setParent(node, null);
}

function elementParentOf(reference: XmlChildNode): WritableElement {
  const parent = reference.parent;
  if (parent === null || parent.kind !== "element") {
    throw invalidOperation("the reference node has no element parent");
  }
  return writableElement(parent);
}

function insertAt(parent: WritableElement, index: number, node: XmlChildNode): void {
  if (index >= parent.children.length) parent.children.push(node);
  else parent.children.splice(index, 0, node);
  setParent(node, parent);
}

export const appendChild: AppendChild = (parent, node) => {
  requireElement(parent);
  requireChildNode(node);
  refuseCycle(parent, node);
  detach(node);
  insertAt(writableElement(parent), parent.children.length, node);
};

export const prependChild: PrependChild = (parent, node) => {
  requireElement(parent);
  requireChildNode(node);
  refuseCycle(parent, node);
  detach(node);
  insertAt(writableElement(parent), 0, node);
};

export const insertBefore: InsertBefore = (reference, node) => {
  requireChildNode(node);
  const parent = elementParentOf(reference);
  if (node === reference) return;
  refuseCycle(parent, node);
  detach(node);
  insertAt(parent, parent.children.indexOf(reference), node);
};

export const insertAfter: InsertAfter = (reference, node) => {
  requireChildNode(node);
  const parent = elementParentOf(reference);
  if (node === reference) return;
  refuseCycle(parent, node);
  detach(node);
  insertAt(parent, parent.children.indexOf(reference) + 1, node);
};

export const remove: Remove = (node) => {
  detach(node);
};

export const replaceNode: ReplaceNode = (node, replacement) => {
  requireChildNode(replacement);
  const parent = elementParentOf(node);
  if (node === replacement) return;
  refuseCycle(parent, replacement);
  detach(replacement);
  parent.children[parent.children.indexOf(node)] = replacement;
  setParent(replacement, parent);
  setParent(node, null);
};

function copyLeaf(node: Exclude<XmlChildNode, XmlElement>): XmlChildNode {
  switch (node.kind) {
    case "text":
      return { kind: "text", value: node.value, raw: node.raw, parent: null };
    case "cdata":
      return { kind: "cdata", value: node.value, parent: null };
    case "comment":
      return { kind: "comment", value: node.value, parent: null };
    case "pi":
      return { kind: "pi", target: node.target, data: node.data, parent: null };
  }
}

function copyElementShell(element: XmlElement): WritableElement {
  const attrs: XmlAttr[] = [];
  for (const attr of element.attrs) {
    attrs.push({ name: attr.name, value: attr.value, raw: attr.raw, quote: attr.quote, lead: attr.lead, eq: attr.eq });
  }
  return {
    kind: "element",
    name: element.name,
    attrs,
    children: [],
    parent: null,
    selfClosing: element.selfClosing,
    openTagTail: element.openTagTail,
    closeTagTail: element.closeTagTail,
  };
}

/** Deep copy of an element and everything below it, without recursion. */
function copySubtree(element: XmlElement): WritableElement {
  const top = copyElementShell(element);
  // Pairs of (source element, its copy) whose children are still to be copied.
  const sources: XmlElement[] = [element];
  const copies: WritableElement[] = [top];
  while (sources.length > 0) {
    const source = sources.pop() as XmlElement;
    const copy = copies.pop() as WritableElement;
    for (const entry of source.children) {
      if (entry.kind === "element") {
        const shell = copyElementShell(entry);
        shell.parent = copy;
        copy.children.push(shell);
        if (entry.children.length > 0) {
          sources.push(entry);
          copies.push(shell);
        }
      } else {
        const leaf = copyLeaf(entry);
        setParent(leaf, copy);
        copy.children.push(leaf);
      }
    }
  }
  return top;
}

export const cloneNode: CloneNode = <T extends XmlChildNode>(node: T): T => {
  requireChildNode(node);
  const source: XmlChildNode = node;
  return (source.kind === "element" ? copySubtree(source) : copyLeaf(source)) as XmlChildNode as T;
};

export const cloneDocument: CloneDocument = (document) => {
  if ((document as { kind?: unknown } | null)?.kind !== "document") {
    throw invalidArgument("cloneDocument expects a document");
  }
  const copy: WritableDocument = { kind: "document", children: [], root: null as never, bom: document.bom };
  for (const entry of document.children) {
    if (entry.kind === "declaration") {
      copy.children.push({
        kind: "declaration",
        raw: entry.raw,
        version: entry.version,
        encoding: entry.encoding,
        standalone: entry.standalone,
        parent: copy,
      });
    } else if (entry.kind === "element") {
      const element = copySubtree(entry);
      element.parent = copy;
      copy.children.push(element);
      if (entry === document.root) copy.root = element;
    } else {
      const leaf = copyLeaf(entry);
      setParent(leaf, copy);
      copy.children.push(leaf);
    }
  }
  return copy;
};

export const setTextContent: SetTextContent = (element, text) => {
  requireElement(element);
  requireString(text, "text");
  const target = writableElement(element);
  for (const entry of target.children) setParent(entry, null);
  target.children.length = 0;
  if (text !== "") target.children.push({ kind: "text", value: text, raw: null, parent: element });
};

export const setText: SetText = (node, value) => {
  if ((node as { kind?: unknown } | null)?.kind !== "text") throw invalidArgument("setText expects a text node");
  requireString(value, "text");
  const target = node as WritableText;
  target.value = value;
  target.raw = null;
};
