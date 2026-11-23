/**
 * Complex fields and deletion: when the whole result of a field goes, its
 * code goes with it (the begin, instruction, separator and end runs), as it
 * does when a field is selected and deleted in a word processor.
 */

import type { XmlElement } from "../../api/xml.js";
import type { InlineAtom, ParagraphScan } from "../internal.js";
import { REVISION_CONTAINERS, attr } from "../internal.js";

const LOOK_THROUGH: ReadonlySet<string> = new Set([
  "w:hyperlink",
  "w:smartTag",
  "w:customXml",
  "w:sdt",
  "w:sdtContent",
  "w:dir",
  "w:bdo",
  "w:fldSimple",
]);

/** Every `w:r` of a paragraph in document order, looking through inline wrappers. */
export function runsInOrder(paragraph: XmlElement): XmlElement[] {
  const runs: XmlElement[] = [];
  const walk = (parent: XmlElement, depth: number): void => {
    for (const node of parent.children) {
      if (node.kind !== "element") continue;
      if (node.name === "w:r") runs.push(node);
      else if (depth < 64 && (LOOK_THROUGH.has(node.name) || REVISION_CONTAINERS.has(node.name))) walk(node, depth + 1);
    }
  };
  walk(paragraph, 0);
  return runs;
}

function fieldChars(run: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  for (const node of run.children) if (node.kind === "element" && node.name === "w:fldChar") found.push(node);
  return found;
}

/**
 * The runs that hold nothing but the code of fields whose whole result lies
 * in `[from, to)`: runs without text between the begin and the end character
 * of such a field. Fields that start or end outside the paragraph, or share
 * a run with text outside the range, are left alone.
 */
export function codeRunsOfDeletedFields(scan: ParagraphScan, from: number, to: number): XmlElement[] {
  const inside = new Set<XmlElement>();
  const outside = new Set<XmlElement>();
  const textRuns = new Set<XmlElement>();
  const runsInRange = new Set<XmlElement>();
  for (const atom of scan.atoms as readonly InlineAtom[]) {
    const within = atom.start >= from && atom.start + atom.text.length <= to;
    if (atom.run !== null) {
      textRuns.add(atom.run);
      if (within) runsInRange.add(atom.run);
    }
    for (const frame of atom.context.fields) {
      if (frame.key.name !== "w:fldChar") continue;
      (within ? inside : outside).add(frame.key);
    }
  }
  const whole = [...inside].filter((key) => !outside.has(key) && !scan.fieldsIn.some((frame) => frame.key === key));
  if (whole.length === 0) return [];
  const runs = runsInOrder(scan.paragraph);
  const found: XmlElement[] = [];
  for (const key of whole) {
    const begin = runs.findIndex((run) => run.children.includes(key));
    if (begin === -1) continue;
    let depth = 0;
    let end = -1;
    for (let at = begin; at < runs.length && end === -1; at++) {
      for (const char of fieldChars(runs[at] as XmlElement)) {
        const type = attr(char, "w:fldCharType");
        if (type === "begin") {
          if (at > begin || char === key) depth += 1;
        } else if (type === "end" && depth > 0) {
          depth -= 1;
          if (depth === 0) {
            end = at;
            break;
          }
        }
      }
    }
    if (end === -1) continue;
    const span = runs.slice(begin, end + 1);
    // A run that also holds text outside the range keeps the field alive.
    if (span.some((run) => textRuns.has(run) && !runsInRange.has(run))) continue;
    for (const run of span) if (!textRuns.has(run) && !found.includes(run)) found.push(run);
  }
  return found;
}
