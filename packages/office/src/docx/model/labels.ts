/**
 * Clause labels: the number a reader would cite a paragraph by, whether the
 * word processor numbers it automatically (`3.1`, `(a)`) or the author typed
 * it at the start of the paragraph (`8.2`, then a tab).
 *
 * Each labelled paragraph of the body gets a key, the way a reference would
 * write it: `8.2`, `10.2(b)`, `schedule 1`. Sub-items take the key of the
 * clause they belong to as a prefix.
 */

import type { OutlineItem } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import type { DocxIndex } from "./doc-index.js";
import { paragraphText } from "./plain-text.js";
import { tableStyleIdOf } from "./resolve.js";
import type { BlockRecord } from "./structure.js";

export interface ParagraphLabel {
  /** The label as displayed or typed, for example `3.1.` or `(b)`. */
  readonly text: string;
  readonly source: "numbering" | "typed";
  /** The key a reference resolves against, lower case, for example `10.2(b)`. */
  readonly key: string;
}

export interface LabelIndex {
  readonly byParagraph: Map<XmlElement, ParagraphLabel>;
  /** Key to the first paragraph with that key. */
  readonly byKey: Map<string, BlockRecord>;
}

const TYPED_NUMBER = /^(\d{1,3}(?:\.\d{1,3}){0,5})(\.?)(?=([\t  ])|$)/;
const TYPED_PAREN = /^\(([a-zA-Z]{1,4}|\d{1,3})\)(?=[\t  ])/;
const TYPED_WORD = /^(schedule|appendix|annex|annexure|exhibit|article|section|clause)[  ]+(\d{1,3}|[A-Z]|[IVXLC]{1,7})\b/i;
const SUB_ITEM = /^\(?([a-z]{1,4}|\d{1,3})[.)]?$/;
const NUMERIC = /^\d+(?:\.\d+)*$/;

/** A label an author typed at the start of the paragraph text, or null. */
export function typedLabel(text: string, isHeading: boolean): string | null {
  const number = TYPED_NUMBER.exec(text);
  if (number !== null) {
    const [, digits = "", dot = "", separator] = number;
    // `8.2<tab>`, `1. Definitions`, `1.1 Scope`, or a heading `2 Term`; not prose such as `24 months`.
    if (separator === "\t" || dot === "." || digits.includes(".") || (isHeading && separator !== undefined)) {
      return digits + dot;
    }
  }
  const paren = TYPED_PAREN.exec(text);
  if (paren !== null) return paren[0];
  if (isHeading) {
    const word = TYPED_WORD.exec(text);
    if (word !== null) return word[0];
  }
  return null;
}

function normalize(label: string): string {
  return label.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
}

function headingLevelOf(index: DocxIndex, record: BlockRecord): number {
  const table = record.parentTableId === null ? null : index.block(record.parentTableId);
  return index.resolver.paragraph(record.element, tableStyleIdOf(table?.element ?? null)).style.headingLevel;
}

export function buildLabelIndex(index: DocxIndex): LabelIndex {
  const result: LabelIndex = { byParagraph: new Map(), byKey: new Map() };
  const body = index.structure.stories[0];
  if (body === undefined) return result;
  const labels = index.labels;
  /** Key of the last clause that stands on its own; typed sub-items hang under it. */
  let lastStandalone: string | null = null;
  /** Per numbering instance: the key last seen at each level. */
  const levelKeys = new Map<string, Array<string | undefined>>();
  for (const paragraph of body.paragraphs) {
    const record = index.blockOf(paragraph);
    if (record === null) continue;
    const automatic = labels.get(paragraph);
    const headingLevel = headingLevelOf(index, record);
    let label: string | null = null;
    let key: string | null = null;
    let source: ParagraphLabel["source"] = "typed";
    if (automatic !== undefined && automatic.format !== "bullet" && automatic.text.trim() !== "") {
      source = "numbering";
      label = automatic.text;
      const plain = normalize(label);
      const levels = levelKeys.get(automatic.numId) ?? [];
      levelKeys.set(automatic.numId, levels);
      const sub = NUMERIC.test(plain) ? null : SUB_ITEM.exec(plain);
      if (sub !== null && automatic.level > 0) {
        let parent: string | undefined;
        for (let level = automatic.level - 1; parent === undefined && level >= 0; level--) parent = levels[level];
        key = `${parent ?? ""}(${sub[1]})`;
      } else {
        key = plain;
        lastStandalone = key;
      }
      levels[automatic.level] = key;
      levels.length = automatic.level + 1;
    } else if (automatic === undefined) {
      label = typedLabel(paragraphText(index.scan(paragraph), "final"), headingLevel > 0);
      if (label !== null) {
        const plain = normalize(label);
        if (plain.startsWith("(")) {
          key = `${lastStandalone ?? ""}${plain}`;
        } else {
          key = plain;
          lastStandalone = key;
        }
      } else if (headingLevel > 0) {
        // An unnumbered heading starts a part of the document that the clauses before it do not own.
        lastStandalone = null;
      }
    }
    if (label === null || key === null) continue;
    result.byParagraph.set(paragraph, { text: label, source, key });
    if (!result.byKey.has(key)) result.byKey.set(key, record);
  }
  return result;
}

/** Headings of the body in document order. */
export function buildOutline(index: DocxIndex): OutlineItem[] {
  const items: OutlineItem[] = [];
  const body = index.structure.stories[0];
  if (body === undefined) return items;
  for (const paragraph of body.paragraphs) {
    const record = index.blockOf(paragraph);
    if (record === null) continue;
    const level = headingLevelOf(index, record);
    if (level < 1) continue;
    const text = paragraphText(index.scan(paragraph), "final");
    if (text.trim() === "") continue;
    items.push({ blockId: record.id, level, text, numberingLabel: index.labels.get(paragraph)?.text ?? null });
  }
  return items;
}
