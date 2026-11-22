/**
 * Writes a tree back to text without recursion.
 *
 * A node that still has its source spelling (`raw`) is written from it; a
 * node created or changed through a helper is written from its decoded value
 * with standard escaping. Nothing else is normalised, so an unedited tree
 * gives back the parsed text exactly.
 */

import type { SerializeXml, XmlAttr, XmlElement, XmlNode } from "../api/xml.js";
import { escapeAttrValue, escapeXmlText } from "./escape.js";
import { invalidArgument } from "./errors.js";

/** Pieces are joined in batches so the list of pending strings stays small. */
const FLUSH_AT = 4096;

function startTag(element: XmlElement): string {
  let tag = `<${element.name}`;
  const attrs = element.attrs;
  for (let index = 0; index < attrs.length; index++) {
    const attr = attrs[index] as XmlAttr;
    const raw = attr.raw;
    tag += attr.lead + attr.name + attr.eq + attr.quote + (raw != null ? raw : escapeAttrValue(attr.value, attr.quote)) + attr.quote;
  }
  return tag + element.openTagTail;
}

/** CDATA cannot contain its own terminator; split the section around it. */
function cdataSection(value: string): string {
  return `<![CDATA[${value.includes("]]>") ? value.split("]]>").join("]]]]><![CDATA[>") : value}]]>`;
}

export const serializeXml: SerializeXml = (node) => {
  if (node === null || typeof node !== "object" || (node.kind !== "document" && node.kind !== "element")) {
    throw invalidArgument("serializeXml expects a document or an element");
  }

  let out = "";
  const pieces: string[] = [];
  /** Open elements above the list being written, with the resume index in each. */
  const elementStack: XmlElement[] = [];
  const listStack: (readonly XmlNode[])[] = [];
  const indexStack: number[] = [];

  let list: readonly XmlNode[];
  if (node.kind === "document") {
    if (node.bom) pieces.push("﻿");
    list = node.children;
  } else {
    list = [node];
  }
  let index = 0;

  for (;;) {
    if (index < list.length) {
      const current = list[index++] as XmlNode;
      switch (current.kind) {
        case "text":
          pieces.push(current.raw != null ? current.raw : escapeXmlText(current.value));
          break;
        case "element":
          if (current.children.length === 0) {
            pieces.push(
              current.selfClosing
                ? `${startTag(current)}/>`
                : `${startTag(current)}></${current.name}${current.closeTagTail}>`,
            );
          } else {
            pieces.push(`${startTag(current)}>`);
            elementStack.push(current);
            listStack.push(list);
            indexStack.push(index);
            list = current.children;
            index = 0;
          }
          break;
        case "cdata":
          pieces.push(cdataSection(current.value));
          break;
        case "comment":
          pieces.push(`<!--${current.value}-->`);
          break;
        case "pi":
          pieces.push(`<?${current.target}${current.data}?>`);
          break;
        case "declaration":
          pieces.push(current.raw);
          break;
        default:
          throw invalidArgument("serializeXml found a node of an unknown kind");
      }
      if (pieces.length >= FLUSH_AT) {
        out += pieces.join("");
        pieces.length = 0;
      }
    } else {
      const closed = elementStack.pop();
      if (closed === undefined) break;
      pieces.push(`</${closed.name}${closed.closeTagTail}>`);
      list = listStack.pop() as readonly XmlNode[];
      index = indexStack.pop() as number;
    }
  }
  return out + pieces.join("");
};
