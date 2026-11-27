/**
 * Checks a saved `.docx` the way a strict consumer reads it: the structure
 * rules of `./wml-order.ts` on every part, unique revision ids, balanced
 * bookmarks, comment anchors, move ranges and fields, and the references
 * between parts (styles, numbering, notes, comments, relationships).
 *
 * `wordProblems` returns one line per problem; an empty list means the file
 * passed.
 */

import type { XmlElement } from "../../../packages/office/src/index.js";
import { type SavedPackage, attr, elementsOf, readPackage, related, walk } from "./package.js";
import { PROPERTY_CHANGES, TRACK, structureProblems } from "./wml-order.js";

const STORY_TYPES = ["/header", "/footer", "/footnotes", "/endnotes", "/comments"];
const PAIRS: ReadonlyArray<readonly [start: string, end: string]> = [
  ["w:bookmarkStart", "w:bookmarkEnd"],
  ["w:moveFromRangeStart", "w:moveFromRangeEnd"],
  ["w:moveToRangeStart", "w:moveToRangeEnd"],
  ["w:commentRangeStart", "w:commentRangeEnd"],
];

function count<T>(values: Iterable<T>): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function repeated<T>(values: Iterable<T>): T[] {
  return [...count(values)].filter(([, times]) => times > 1).map(([value]) => value);
}

/** Ids, ranges and fields of one story part. */
export function anchorProblems(root: XmlElement, revisionIds: string[]): string[] {
  const problems: string[] = [];
  const all = [...walk(root)];
  const own: string[] = [];
  for (const element of all) {
    if (!TRACK.has(element.name) && !PROPERTY_CHANGES.has(element.name)) continue;
    const id = attr(element, "w:id");
    if (id !== null) own.push(id);
  }
  revisionIds.push(...own);
  const duplicates = repeated(own);
  if (duplicates.length > 0) problems.push(`revision w:id used more than once: ${duplicates.slice(0, 8).join(", ")}`);

  const position = new Map<XmlElement, number>(all.map((element, index) => [element, index]));
  for (const [startName, endName] of PAIRS) {
    const starts = all.filter((element) => element.name === startName);
    const ends = all.filter((element) => element.name === endName);
    for (const id of repeated(starts.map((element) => attr(element, "w:id")))) problems.push(`<${startName}> w:id ${id} is used more than once`);
    for (const id of repeated(ends.map((element) => attr(element, "w:id")))) problems.push(`<${endName}> w:id ${id} is used more than once`);
    const endById = new Map(ends.map((element) => [attr(element, "w:id"), element]));
    const startIds = new Set(starts.map((element) => attr(element, "w:id")));
    for (const start of starts) {
      const id = attr(start, "w:id");
      const end = endById.get(id);
      if (end === undefined) problems.push(`<${startName}> w:id ${id} has no <${endName}>`);
      else if ((position.get(end) ?? 0) < (position.get(start) ?? 0)) problems.push(`<${endName}> w:id ${id} comes before its start`);
    }
    for (const end of ends) if (!startIds.has(attr(end, "w:id"))) problems.push(`<${endName}> w:id ${attr(end, "w:id")} has no <${startName}>`);
  }
  const markers = all.filter((element) => ["w:bookmarkStart", "w:moveFromRangeStart", "w:moveToRangeStart"].includes(element.name));
  for (const id of repeated(markers.map((element) => attr(element, "w:id")))) problems.push(`bookmark and move range markers share w:id ${id}`);
  for (const name of repeated(all.filter((element) => element.name === "w:bookmarkStart").map((element) => attr(element, "w:name")))) {
    problems.push(`bookmark name ${JSON.stringify(name)} is used more than once`);
  }
  const moveNames = (tag: string): string[] => all.filter((element) => element.name === tag).map((element) => attr(element, "w:name") ?? "").sort();
  const from = moveNames("w:moveFromRangeStart");
  const to = moveNames("w:moveToRangeStart");
  if (from.join("\n") !== to.join("\n")) problems.push(`move ranges do not pair by name: from [${from.join(", ")}] to [${to.join(", ")}]`);
  const hasFrom = all.some((element) => element.name === "w:moveFrom");
  const hasTo = all.some((element) => element.name === "w:moveTo");
  if (hasFrom !== hasTo) problems.push("moveFrom and moveTo do not both occur");
  if ((hasFrom || hasTo) && from.length === 0) problems.push("a move has no range markers");

  const paraIds: string[] = [];
  for (const element of all) {
    if (element.name !== "w:p") continue;
    const id = attr(element, "w14:paraId");
    if (id === null) continue;
    paraIds.push(id.toUpperCase());
    if (!/^[0-9A-Fa-f]{8}$/.test(id) || Number.parseInt(id, 16) >= 0x80000000 || Number.parseInt(id, 16) === 0) {
      problems.push(`w14:paraId ${JSON.stringify(id)} is not an 8-digit hex value below 80000000`);
    }
  }
  const sharedParaIds = repeated(paraIds);
  if (sharedParaIds.length > 0) problems.push(`w14:paraId used more than once: ${sharedParaIds.slice(0, 8).join(", ")}`);

  let depth = 0;
  for (const element of all) {
    if (element.name !== "w:fldChar") continue;
    const type = attr(element, "w:fldCharType");
    if (type === "begin") depth += 1;
    else if (type === "end") {
      depth -= 1;
      if (depth < 0) {
        problems.push("a field ends without a begin");
        depth = 0;
      }
    }
  }
  if (depth !== 0) problems.push(`${depth} field(s) begin without an end`);
  return problems;
}

/** Comments against their anchors: every comment has one reference and one balanced range in the body. */
export function commentProblems(pkg: SavedPackage, documentPart: string): string[] {
  const problems: string[] = [];
  const document = pkg.parts.get(documentPart);
  if (document === undefined) return ["the main document part is missing"];
  const all = [...walk(document.root)];
  const ids = (name: string): Map<string | null, number> => count(all.filter((element) => element.name === name).map((element) => attr(element, "w:id")));
  const starts = ids("w:commentRangeStart");
  const ends = ids("w:commentRangeEnd");
  const references = ids("w:commentReference");
  const part = related(pkg, documentPart, "/comments")[0];
  const comments = part === undefined ? undefined : pkg.parts.get(part);
  if (comments === undefined) {
    if (starts.size + ends.size + references.size > 0) problems.push("comment markers without a comments part");
    return problems;
  }
  const entries = elementsOf(comments.root).filter((element) => element.name === "w:comment");
  const defined = entries.map((element) => attr(element, "w:id"));
  for (const id of repeated(defined)) problems.push(`comment id ${id} is defined more than once`);
  const lastParagraph = new Map<string, string | null>();
  for (const comment of entries) {
    const id = attr(comment, "w:id");
    if (id === null || !/^\d+$/.test(id)) problems.push(`a comment has the bad w:id ${JSON.stringify(id)}`);
    if ((attr(comment, "w:author") ?? "") === "") problems.push(`comment ${id} has no author`);
    const paragraphs = elementsOf(comment).filter((element) => element.name === "w:p");
    if (paragraphs.length === 0) problems.push(`comment ${id} has no paragraph`);
    const paraId = paragraphs.length === 0 ? null : attr(paragraphs[paragraphs.length - 1] as XmlElement, "w14:paraId");
    if (paraId !== null) lastParagraph.set(paraId.toUpperCase(), id);
    if ((references.get(id) ?? 0) !== 1) problems.push(`comment ${id} has ${references.get(id) ?? 0} commentReference elements`);
    if ((starts.get(id) ?? 0) !== (ends.get(id) ?? 0)) problems.push(`comment ${id} has ${starts.get(id) ?? 0} range starts and ${ends.get(id) ?? 0} range ends`);
    if ((starts.get(id) ?? 0) > 1) problems.push(`comment ${id} has ${starts.get(id)} ranges`);
  }
  for (const id of new Set([...starts.keys(), ...ends.keys(), ...references.keys()])) {
    if (!defined.includes(id)) problems.push(`comment marker ${id} has no comment`);
  }
  const extendedPart = related(pkg, documentPart, "/commentsExtended")[0];
  const extended = extendedPart === undefined ? undefined : pkg.parts.get(extendedPart);
  if (extended !== undefined) {
    for (const entry of walk(extended.root)) {
      if (entry.name !== "w15:commentEx") continue;
      const paraId = (attr(entry, "w15:paraId") ?? "").toUpperCase();
      if (!lastParagraph.has(paraId)) problems.push(`commentEx paraId ${paraId} is not the last paragraph of a comment`);
      const parent = attr(entry, "w15:paraIdParent");
      if (parent !== null && !lastParagraph.has(parent.toUpperCase())) problems.push(`commentEx paraIdParent ${parent} is not the last paragraph of a comment`);
    }
  }
  return problems;
}

/** References from the stories to styles, numbering, notes and relationships. */
function referenceProblems(pkg: SavedPackage, documentPart: string, stories: readonly string[]): string[] {
  const problems: string[] = [];
  const styleIds = new Set<string | null>();
  for (const part of related(pkg, documentPart, "/styles")) {
    const root = pkg.parts.get(part)?.root;
    if (root === undefined) continue;
    const ids = [...walk(root)].filter((element) => element.name === "w:style").map((element) => attr(element, "w:styleId"));
    for (const id of repeated(ids)) problems.push(`${part}: style id ${JSON.stringify(id)} is defined more than once`);
    for (const id of ids) styleIds.add(id);
    for (const element of walk(root)) {
      if (["w:basedOn", "w:next", "w:link"].includes(element.name) && !styleIds.has(attr(element, "w:val"))) {
        problems.push(`${part}: <${element.name}> names the undefined style ${JSON.stringify(attr(element, "w:val"))}`);
      }
    }
  }
  const numIds = new Set<string | null>();
  for (const part of related(pkg, documentPart, "/numbering")) {
    const root = pkg.parts.get(part)?.root;
    if (root === undefined) continue;
    const abstract = new Set(elementsOf(root).filter((element) => element.name === "w:abstractNum").map((element) => attr(element, "w:abstractNumId")));
    for (const num of elementsOf(root).filter((element) => element.name === "w:num")) {
      if (numIds.has(attr(num, "w:numId"))) problems.push(`${part}: numId ${attr(num, "w:numId")} is defined more than once`);
      numIds.add(attr(num, "w:numId"));
      const reference = elementsOf(num).find((element) => element.name === "w:abstractNumId");
      if (reference === undefined || !abstract.has(attr(reference, "w:val"))) problems.push(`${part}: num ${attr(num, "w:numId")} refers to a missing abstractNum`);
    }
  }
  for (const part of stories) {
    const root = pkg.parts.get(part)?.root;
    if (root === undefined) continue;
    const relationships = pkg.relationships.get(part) ?? new Map();
    for (const element of walk(root)) {
      if (["w:pStyle", "w:rStyle", "w:tblStyle"].includes(element.name) && !styleIds.has(attr(element, "w:val"))) {
        problems.push(`${part}: <${element.name}> names the undefined style ${JSON.stringify(attr(element, "w:val"))}`);
      }
      if (element.name === "w:numId") {
        const value = attr(element, "w:val");
        if (value !== null && value !== "0" && !numIds.has(value)) problems.push(`${part}: numId ${value} is not defined in the numbering part`);
      }
      for (const entry of element.attrs) {
        if (entry.name.startsWith("r:") && entry.value !== "" && !relationships.has(entry.value)) {
          problems.push(`${part}: <${element.name}> refers to the missing relationship ${entry.value}`);
        }
      }
    }
  }
  const body = pkg.parts.get(documentPart)?.root;
  for (const kind of ["footnote", "endnote"]) {
    const defined = new Set<string | null>();
    for (const part of related(pkg, documentPart, `/${kind}s`)) {
      const root = pkg.parts.get(part)?.root;
      if (root === undefined) continue;
      for (const note of elementsOf(root)) if (note.name === `w:${kind}`) defined.add(attr(note, "w:id"));
    }
    if (body === undefined) continue;
    const references = [...walk(body)].filter((element) => element.name === `w:${kind}Reference`).map((element) => attr(element, "w:id"));
    for (const id of references) if (!defined.has(id)) problems.push(`${kind}Reference ${id} has no ${kind}`);
    for (const id of repeated(references)) problems.push(`${kind} ${id} is referenced more than once`);
  }
  return problems;
}

/** Every problem of a saved `.docx`, each prefixed with its part name. */
export async function wordProblems(bytes: Uint8Array): Promise<string[]> {
  const pkg = await readPackage(bytes);
  const documentPart = related(pkg, "/", "/officeDocument")[0] ?? "/word/document.xml";
  const stories = [documentPart];
  for (const suffix of STORY_TYPES) stories.push(...related(pkg, documentPart, suffix));
  const others = [...related(pkg, documentPart, "/styles"), ...related(pkg, documentPart, "/settings"), ...related(pkg, documentPart, "/numbering")];
  const problems: string[] = [];
  const revisionIds: string[] = [];
  for (const part of [...new Set([...stories, ...others])]) {
    const root = pkg.parts.get(part)?.root;
    if (root === undefined) {
      problems.push(`${part}: the part is missing or is not XML`);
      continue;
    }
    for (const problem of structureProblems(root)) problems.push(`${part}: ${problem}`);
    if (stories.includes(part)) for (const problem of anchorProblems(root, revisionIds)) problems.push(`${part}: ${problem}`);
    if (stories.includes(part) && part !== documentPart && !related(pkg, documentPart, "/comments").includes(part)) {
      // The comments part belongs to the main document; no other story can refer to it.
      for (const element of walk(root)) {
        if (["w:commentRangeStart", "w:commentRangeEnd", "w:commentReference"].includes(element.name)) {
          problems.push(`${part}: <${element.name}> outside the main document`);
          break;
        }
      }
    }
  }
  const shared = repeated(revisionIds);
  if (shared.length > 0) problems.push(`revision w:id used in more than one place across the parts: ${shared.slice(0, 8).join(", ")}`);
  for (const problem of commentProblems(pkg, documentPart)) problems.push(`${documentPart}: ${problem}`);
  problems.push(...referenceProblems(pkg, documentPart, stories));
  return problems;
}
