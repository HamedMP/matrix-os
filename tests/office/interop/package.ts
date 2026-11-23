/**
 * Reads a saved package for the interoperability checks: the XML parts as
 * trees, by part name, through the engine's own container and XML modules.
 *
 * The rule checkers in this folder look at the raw XML the way a strict
 * consumer does, so they use none of the document or workbook model.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { XmlDocument, XmlElement } from "../../../packages/office/src/index.js";
import { opc, xml } from "../../../packages/office/src/index.js";

export const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

export interface SavedPackage {
  /** Parsed XML parts by part name (`/word/document.xml`). */
  parts: Map<string, XmlDocument>;
  contentTypes: Map<string, string | null>;
  /** Internal relationship targets by source part: relationship id to `[type, part name]`. */
  relationships: Map<string, Map<string, [type: string, target: string]>>;
}

function resolveTarget(source: string, target: string): string {
  if (target.startsWith("/")) return target;
  const segments = source.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== ".") segments.push(segment);
  }
  return segments.join("/");
}

export async function readPackage(bytes: Uint8Array): Promise<SavedPackage> {
  const pkg = await opc.openPackage(bytes);
  const parts = new Map<string, XmlDocument>();
  const contentTypes = new Map<string, string | null>();
  const relationships: SavedPackage["relationships"] = new Map();
  for (const part of pkg.listParts({ includeRelationships: true })) {
    contentTypes.set(part.name, part.contentType);
    if (part.isRelationships || /\.xml$/i.test(part.name)) parts.set(part.name, xml.parseXml(await pkg.getPartText(part.name)));
    if (part.isRelationships) continue;
    const targets = new Map<string, [string, string]>();
    for (const relationship of pkg.getRelationships(part.name)) {
      if (relationship.targetMode === "Internal") targets.set(relationship.id, [relationship.type, resolveTarget(part.name, relationship.target)]);
      else targets.set(relationship.id, [relationship.type, ""]);
    }
    relationships.set(part.name, targets);
  }
  const top = new Map<string, [string, string]>();
  for (const relationship of pkg.getRelationships("/")) {
    top.set(relationship.id, [relationship.type, relationship.targetMode === "Internal" ? resolveTarget("/", relationship.target) : ""]);
  }
  relationships.set("/", top);
  return { parts, contentTypes, relationships };
}

/** Parts related from `source` by a relationship type ending in `suffix`. */
export function related(pkg: SavedPackage, source: string, suffix: string): string[] {
  const out: string[] = [];
  for (const [type, target] of pkg.relationships.get(source)?.values() ?? []) if (type.endsWith(suffix) && target !== "") out.push(target);
  return out;
}

export function elementsOf(parent: XmlElement): XmlElement[] {
  return parent.children.filter((node): node is XmlElement => node.kind === "element");
}

/** Every element under `root` in document order, `root` included. */
export function* walk(root: XmlElement): Generator<XmlElement> {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    yield element;
    const children = elementsOf(element);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as XmlElement);
  }
}

export function attr(element: XmlElement, name: string): string | null {
  for (const entry of element.attrs) if (entry.name === name) return entry.value;
  return null;
}

export function parentElement(element: XmlElement): XmlElement | null {
  const parent = element.parent;
  return parent !== null && parent.kind === "element" ? parent : null;
}

export function hasAncestor(element: XmlElement, names: ReadonlySet<string>): boolean {
  for (let scope = parentElement(element); scope !== null; scope = parentElement(scope)) if (names.has(scope.name)) return true;
  return false;
}

export function text(element: XmlElement): string {
  return xml.textContent(element);
}

/** The text of an element as it is spelled in the file, character references not decoded. */
export function sourceText(element: XmlElement): string {
  let out = "";
  for (const node of element.children) if (node.kind === "text") out += node.raw ?? node.value;
  return out;
}

/** A short path for messages: the names of the last few ancestors. */
export function where(element: XmlElement): string {
  const names: string[] = [];
  for (let scope: XmlElement | null = element; scope !== null && names.length < 5; scope = parentElement(scope)) names.unshift(scope.name);
  return names.join("/");
}

/**
 * Checks that the children of `element` named in `order` come in that order
 * and that no child outside it (with the same prefix) appears. `repeatable`
 * names may occur more than once.
 */
export function orderProblems(
  element: XmlElement,
  order: readonly string[],
  what: string,
  prefix: string,
  repeatable: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  let last = -1;
  let lastName = "";
  const seen = new Set<string>();
  for (const child of elementsOf(element)) {
    if (!child.name.startsWith(prefix) && prefix !== "") continue;
    if (prefix === "" && child.name.includes(":")) continue;
    const index = order.indexOf(child.name);
    if (index === -1) {
      problems.push(`<${child.name}> is not allowed in <${what}> (${where(element)})`);
      continue;
    }
    if (index < last) problems.push(`<${child.name}> comes after <${lastName}> in <${what}> (${where(element)})`);
    else {
      last = index;
      lastName = child.name;
    }
    if (seen.has(child.name) && !repeatable.has(child.name)) problems.push(`<${child.name}> appears twice in <${what}> (${where(element)})`);
    seen.add(child.name);
  }
  return problems;
}
