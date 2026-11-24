/**
 * Read-only lookups. Matching is by qualified name exactly as written in the
 * document; use the namespace helpers when a prefix cannot be assumed.
 * Every walk uses an explicit stack, so tree depth cannot overflow the call stack.
 */

import type {
  Child,
  Children,
  Find,
  FindAll,
  GetAttr,
  IsWhitespaceText,
  TextContent,
  XmlAttr,
  XmlChildNode,
  XmlDocument,
  XmlElement,
  XmlNode,
  XmlText,
} from "../api/xml.js";
import { firstNonSpace } from "./chars.js";

export const child: Child = (parent, name) => {
  const nodes = parent.children;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as XmlChildNode;
    if (node.kind === "element" && node.name === name) return node;
  }
  return null;
};

export const children: Children = (parent, name) => {
  const found: XmlElement[] = [];
  const nodes = parent.children;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as XmlChildNode;
    if (node.kind === "element" && (name === undefined || node.name === name)) found.push(node);
  }
  return found;
};

/** Collects matching descendants in document order; stops at the first when asked. */
function collect(start: XmlElement | XmlDocument, name: string, found: XmlElement[], firstOnly: boolean): void {
  const listStack: (readonly XmlNode[])[] = [];
  const indexStack: number[] = [];
  let list: readonly XmlNode[] = start.children;
  let index = 0;
  for (;;) {
    if (index < list.length) {
      const node = list[index++] as XmlNode;
      if (node.kind !== "element") continue;
      if (node.name === name) {
        found.push(node);
        if (firstOnly) return;
      }
      if (node.children.length > 0) {
        listStack.push(list);
        indexStack.push(index);
        list = node.children;
        index = 0;
      }
    } else {
      const outer = listStack.pop();
      if (outer === undefined) return;
      list = outer;
      index = indexStack.pop() as number;
    }
  }
}

export const find: Find = (start, name) => {
  const found: XmlElement[] = [];
  collect(start, name, found, true);
  return found.length === 0 ? null : (found[0] as XmlElement);
};

export const findAll: FindAll = (start, name) => {
  const found: XmlElement[] = [];
  collect(start, name, found, false);
  return found;
};

export const getAttr: GetAttr = (element, name) => {
  const attrs = element.attrs;
  for (let index = 0; index < attrs.length; index++) {
    const attr = attrs[index] as XmlAttr;
    if (attr.name === name) return attr.value;
  }
  return null;
};

export const textContent: TextContent = (node) => {
  if (node.kind !== "element") return node.value;
  let text = "";
  const listStack: (readonly XmlChildNode[])[] = [];
  const indexStack: number[] = [];
  let list: readonly XmlChildNode[] = node.children;
  let index = 0;
  for (;;) {
    if (index < list.length) {
      const current = list[index++] as XmlChildNode;
      if (current.kind === "text" || current.kind === "cdata") {
        text += current.value;
      } else if (current.kind === "element" && current.children.length > 0) {
        listStack.push(list);
        indexStack.push(index);
        list = current.children;
        index = 0;
      }
    } else {
      const outer = listStack.pop();
      if (outer === undefined) return text;
      list = outer;
      index = indexStack.pop() as number;
    }
  }
};

export const isWhitespaceText: IsWhitespaceText = (node): node is XmlText =>
  node.kind === "text" && firstNonSpace(node.value, 0, node.value.length) === -1;
