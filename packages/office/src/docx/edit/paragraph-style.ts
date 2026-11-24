/** Paragraph properties: writing a `ParagraphStylePatch` into a `w:pPr`. */

import type { ParagraphStylePatch } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, createElement, remove, removeAttr, setAttr } from "../../xml/index.js";
import type { DocxIndex } from "../internal.js";
import { firstChild } from "../internal.js";
import { PPR_ORDER } from "./schema-order.js";
import { ensureChild, insertOrdered } from "./xml-util.js";

const PATCH_KEYS: ReadonlySet<string> = new Set([
  "styleId",
  "headingLevel",
  "alignment",
  "indentLeftPt",
  "indentRightPt",
  "firstLineIndentPt",
  "spacingBeforePt",
  "spacingAfterPt",
]);

const ALIGNMENT_VALUES: Readonly<Record<string, string>> = { left: "left", center: "center", right: "right", justify: "both" };

function invalid(message: string): OfficeError {
  return new OfficeError("invalid_argument", message);
}

/** Checks the shape of a paragraph style patch (`invalid_argument`). */
export function requireParagraphPatch(value: unknown, what = "style"): asserts value is Partial<ParagraphStylePatch> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${what} must be an object`);
  const patch = value as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) throw invalid(`${what} has an unknown property`);
    const entry = patch[key];
    if (entry === undefined) continue;
    if (key === "styleId") {
      if (entry !== null && (typeof entry !== "string" || entry === "")) throw invalid(`${what}.styleId must be a style id or null`);
    } else if (key === "headingLevel") {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 9) {
        throw invalid(`${what}.headingLevel must be 0 to 9`);
      }
    } else if (key === "alignment") {
      if (typeof entry !== "string" || ALIGNMENT_VALUES[entry] === undefined) throw invalid(`${what}.alignment is not a known value`);
    } else if (typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 1584) {
      throw invalid(`${what}.${key} must be a length in points`);
    } else if (key !== "firstLineIndentPt" && key !== "indentLeftPt" && key !== "indentRightPt" && entry < 0) {
      throw invalid(`${what}.${key} must not be negative`);
    }
  }
}

function twips(points: number): string {
  return String(Math.round(points * 20));
}

/** The id of the built-in heading style of a level, creating the style when the document has none. */
function headingStyleId(index: DocxIndex, level: number): string {
  const styles = index.resolver.styles;
  const existing = styles.findByName(`heading ${level}`, "paragraph");
  if (existing !== null) return existing;
  const root = index.ensurePart("styles");
  let id = `Heading${level}`;
  for (let attempt = 2; styles.has(id) && attempt < 1000; attempt++) id = `Heading${level}_${attempt}`;
  const sizes = [32, 26, 24, 22, 22, 22, 22, 22, 22];
  const style = createElement("w:style", [
    ["w:type", "paragraph"],
    ["w:styleId", id],
  ]);
  appendChild(style, createElement("w:name", [["w:val", `heading ${level}`]]));
  const base = styles.defaultParagraphStyleId;
  if (base !== null) {
    appendChild(style, createElement("w:basedOn", [["w:val", base]]));
    appendChild(style, createElement("w:next", [["w:val", base]]));
  }
  appendChild(style, createElement("w:uiPriority", [["w:val", "9"]]));
  appendChild(style, createElement("w:qFormat"));
  const paragraph = createElement("w:pPr");
  appendChild(paragraph, createElement("w:keepNext"));
  appendChild(paragraph, createElement("w:spacing", [["w:before", level === 1 ? "240" : "120"], ["w:after", "60"]]));
  appendChild(paragraph, createElement("w:outlineLvl", [["w:val", String(level - 1)]]));
  appendChild(style, paragraph);
  const run = createElement("w:rPr");
  appendChild(run, createElement("w:b"));
  appendChild(run, createElement("w:bCs"));
  const size = String(sizes[level - 1] ?? 22);
  appendChild(run, createElement("w:sz", [["w:val", size]]));
  appendChild(run, createElement("w:szCs", [["w:val", size]]));
  appendChild(style, run);
  // `w:latentStyles` and `w:docDefaults` come first; styles are appended in any order after them.
  appendChild(root, style);
  index.markDirty(style);
  return id;
}

function setStyle(properties: XmlElement, styleId: string | null): void {
  const existing = firstChild(properties, "w:pStyle");
  if (styleId === null) {
    if (existing !== null) remove(existing);
  } else if (existing !== null) {
    setAttr(existing, "w:val", styleId);
  } else {
    insertOrdered(properties, createElement("w:pStyle", [["w:val", styleId]]), PPR_ORDER);
  }
}

function dropEmpty(properties: XmlElement, name: string): void {
  const element = firstChild(properties, name);
  if (element !== null && element.attrs.length === 0) remove(element);
}

/**
 * Writes the given properties into `properties` (a `w:pPr`, changed in
 * place). Throws `invalid_operation` for an unknown style id.
 */
export function applyParagraphPatch(index: DocxIndex, properties: XmlElement, patch: Partial<ParagraphStylePatch>): void {
  if (patch.headingLevel !== undefined) {
    const outline = firstChild(properties, "w:outlineLvl");
    if (outline !== null) remove(outline);
    setStyle(properties, patch.headingLevel === 0 ? null : headingStyleId(index, patch.headingLevel));
  } else if (patch.styleId !== undefined) {
    if (patch.styleId !== null) {
      const record = index.resolver.styles.get(patch.styleId);
      if (record === null || record.type !== "paragraph") {
        throw new OfficeError("invalid_operation", "unknown paragraph style", { details: { styleId: patch.styleId } });
      }
    }
    setStyle(properties, patch.styleId);
  }
  if (patch.alignment !== undefined) {
    const alignment = ensureChild(properties, "w:jc", PPR_ORDER);
    setAttr(alignment, "w:val", ALIGNMENT_VALUES[patch.alignment] as string);
  }
  if (patch.indentLeftPt !== undefined || patch.indentRightPt !== undefined || patch.firstLineIndentPt !== undefined) {
    const indent = ensureChild(properties, "w:ind", PPR_ORDER);
    if (patch.indentLeftPt !== undefined) {
      removeAttr(indent, "w:start");
      setAttr(indent, "w:left", twips(patch.indentLeftPt));
    }
    if (patch.indentRightPt !== undefined) {
      removeAttr(indent, "w:end");
      setAttr(indent, "w:right", twips(patch.indentRightPt));
    }
    if (patch.firstLineIndentPt !== undefined) {
      removeAttr(indent, "w:hanging");
      removeAttr(indent, "w:firstLine");
      if (patch.firstLineIndentPt < 0) setAttr(indent, "w:hanging", twips(-patch.firstLineIndentPt));
      else setAttr(indent, "w:firstLine", twips(patch.firstLineIndentPt));
    }
    dropEmpty(properties, "w:ind");
  }
  if (patch.spacingBeforePt !== undefined || patch.spacingAfterPt !== undefined) {
    const spacing = ensureChild(properties, "w:spacing", PPR_ORDER);
    if (patch.spacingBeforePt !== undefined) {
      removeAttr(spacing, "w:beforeAutospacing");
      setAttr(spacing, "w:before", twips(patch.spacingBeforePt));
    }
    if (patch.spacingAfterPt !== undefined) {
      removeAttr(spacing, "w:afterAutospacing");
      setAttr(spacing, "w:after", twips(patch.spacingAfterPt));
    }
  }
}
