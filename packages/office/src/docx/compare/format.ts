/**
 * Formatting differences: a canonical form of run and paragraph properties
 * to compare them by, and the writers of the formatting revisions
 * (`w:rPrChange`, `w:pPrChange`) that record the properties of the original.
 */

import type { XmlElement } from "../../api/xml.js";
import { appendChild, cloneNode, createElement, prependChild, remove, replaceNode } from "../../xml/index.js";
import { firstChild } from "../internal.js";
import { ensureParagraphProperties } from "./markup.js";
import { type Para, nodesInRange } from "./runs.js";
import type { Stamp } from "./types.js";

/** Run properties that say nothing about how the text looks, and the records of earlier changes. */
const RUN_NOISE: ReadonlySet<string> = new Set(["w:rPrChange", "w:lang", "w:noProof", "w:ins", "w:del", "w:moveFrom", "w:moveTo"]);

/** Children of `w:pPr` that are not properties of the paragraph itself. */
const PARAGRAPH_APART: ReadonlySet<string> = new Set(["w:rPr", "w:sectPr", "w:pPrChange"]);

function canonicalValue(name: string, value: string): string {
  if (name !== "w:val") return value;
  if (value === "true" || value === "on") return "1";
  if (value === "false" || value === "off") return "0";
  return value;
}

function canonicalElement(element: XmlElement): string {
  const attrs: string[] = [];
  for (const entry of element.attrs) {
    if (entry.name.startsWith("xmlns") || entry.name.startsWith("w:rsid")) continue;
    attrs.push(`${entry.name}=${JSON.stringify(canonicalValue(entry.name, entry.value))}`);
  }
  attrs.sort();
  const children: string[] = [];
  for (const node of element.children) if (node.kind === "element") children.push(canonicalElement(node));
  children.sort();
  // `<w:b/>` and `<w:b w:val="1"/>` say the same.
  const attributes = children.length === 0 && attrs.length === 1 && attrs[0] === 'w:val="1"' ? "" : attrs.join(" ");
  return `<${element.name} ${attributes}>${children.join("")}`;
}

function canonicalProperties(properties: XmlElement | null, skip: ReadonlySet<string>): string {
  if (properties === null) return "";
  const children: string[] = [];
  for (const node of properties.children) {
    if (node.kind === "element" && !skip.has(node.name)) children.push(canonicalElement(node));
  }
  return children.sort().join("");
}

const runCache = new WeakMap<XmlElement, string>();

/** Canonical form of a `w:rPr` (or of no run properties). Equal strings mean equal formatting. */
export function canonicalRunProperties(rPr: XmlElement | null): string {
  if (rPr === null) return "";
  let known = runCache.get(rPr);
  if (known === undefined) {
    known = canonicalProperties(rPr, RUN_NOISE);
    runCache.set(rPr, known);
  }
  return known;
}

/** Canonical form of a `w:pPr`, without its mark properties, section and change record. */
export function canonicalParagraphProperties(pPr: XmlElement | null): string {
  return canonicalProperties(pPr, PARAGRAPH_APART);
}

function changeAttrs(stamp: Stamp): Array<readonly [string, string]> {
  return [
    ["w:id", stamp.nextId()],
    ["w:author", stamp.author],
    ["w:date", stamp.date],
  ];
}

/**
 * Gives the runs of `[start, end)` new properties and records the old ones.
 * `properties` is a detached `w:rPr` used as a template (null for none).
 * Returns the number of runs changed.
 */
export function applyRunFormat(para: Para, start: number, end: number, properties: XmlElement | null, stamp: Stamp): number {
  let changed = 0;
  for (const run of nodesInRange(para, start, end, stamp)) {
    if (run.name !== "w:r") continue;
    const old = firstChild(run, "w:rPr");
    const before = createElement("w:rPr");
    if (old !== null) {
      for (const node of old.children) {
        if (node.kind === "element" && node.name !== "w:rPrChange") appendChild(before, cloneNode(node));
      }
    }
    const next = properties === null ? createElement("w:rPr") : cloneNode(properties);
    appendChild(next, createElement("w:rPrChange", changeAttrs(stamp), [before]));
    if (old !== null) replaceNode(old, next);
    else prependChild(run, next);
    changed += 1;
  }
  return changed;
}

/**
 * Gives a paragraph new properties and records the old ones. `properties` is
 * a detached `w:pPr` used as a template (null for none). The mark properties
 * and the section break of the paragraph stay as they are.
 */
export function applyParagraphFormat(paragraph: XmlElement, properties: XmlElement | null, stamp: Stamp): void {
  const pPr = ensureParagraphProperties(paragraph);
  const before = createElement("w:pPr");
  const kept: XmlElement[] = [];
  for (const node of [...pPr.children]) {
    if (node.kind !== "element") {
      remove(node);
    } else if (node.name === "w:rPr" || node.name === "w:sectPr") {
      kept.push(node);
    } else if (node.name === "w:pPrChange") {
      remove(node);
    } else {
      appendChild(before, node);
    }
  }
  if (properties !== null) {
    for (const node of properties.children) {
      if (node.kind === "element" && !PARAGRAPH_APART.has(node.name)) appendChild(pPr, cloneNode(node));
    }
  }
  // Schema order: the properties, then `w:rPr`, `w:sectPr` and the change record.
  for (const name of ["w:rPr", "w:sectPr"]) {
    for (const node of kept) if (node.name === name) appendChild(pPr, node);
  }
  appendChild(pPr, createElement("w:pPrChange", changeAttrs(stamp), [before]));
}
