/**
 * Effective formatting: what a paragraph and a run look like once the
 * document defaults, the table style, the paragraph style chain, the
 * numbering level, the character style and the direct formatting are layered.
 */

import type { ParagraphStylePatch, ResolvedParagraphStyle, RunFormat } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { childVal, firstChild } from "./names.js";
import type { NumberingDefinitions } from "./numbering.js";
import {
  type ParagraphProps,
  RUN_FORMAT_KEYS,
  type RunProps,
  completeRunFormat,
  readParagraphProps,
  readRunProps,
} from "./props.js";
import { type StyleSheet, displayStyleName, headingLevelOfName } from "./styles.js";

export interface ResolvedParagraph {
  readonly style: ResolvedParagraphStyle;
  /** Run properties every run of the paragraph starts from. */
  readonly runBase: RunProps;
  /** The numbering instance and level of the paragraph, or null when it is not numbered. */
  readonly numbering: { readonly numId: string; readonly level: number } | null;
}

const PATCH_KEYS: ReadonlyArray<keyof ParagraphStylePatch> = [
  "styleId",
  "headingLevel",
  "alignment",
  "indentLeftPt",
  "indentRightPt",
  "firstLineIndentPt",
  "spacingBeforePt",
  "spacingAfterPt",
];

/** The `w:tblStyle` of a table, or null. */
export function tableStyleIdOf(table: XmlElement | null): string | null {
  const tblPr = table === null ? null : firstChild(table, "w:tblPr");
  return tblPr === null ? null : childVal(tblPr, "w:tblStyle");
}

export class FormatResolver {
  readonly styles: StyleSheet;
  readonly numbering: NumberingDefinitions;
  private readonly inheritedCache = new Map<string, { paragraph: ParagraphProps; run: RunProps }>();
  private readonly characterCache = new Map<string, RunProps>();

  constructor(styles: StyleSheet, numbering: NumberingDefinitions) {
    this.styles = styles;
    this.numbering = numbering;
  }

  /** Everything a paragraph inherits before its own `w:pPr` is applied. */
  private inherited(styleId: string | null, tableStyleId: string | null): { paragraph: ParagraphProps; run: RunProps } {
    const key = `${styleId ?? ""}\u0000${tableStyleId ?? ""}`;
    const known = this.inheritedCache.get(key);
    if (known !== undefined) return known;
    const paragraph: ParagraphProps = { ...this.styles.defaultParagraph };
    const run: RunProps = { ...this.styles.defaultRun };
    for (const record of this.styles.chain(tableStyleId)) {
      Object.assign(paragraph, record.paragraph);
      Object.assign(run, record.run);
    }
    for (const record of this.styles.chain(styleId)) {
      const numId = record.paragraph.numId;
      if (numId !== undefined && numId !== "0") {
        const level = record.paragraph.numLevel ?? this.numbering.levelForStyle(numId, record.id) ?? 0;
        Object.assign(paragraph, this.numbering.level(numId, level)?.paragraph);
      }
      Object.assign(paragraph, record.paragraph);
      Object.assign(run, record.run);
    }
    delete paragraph.styleId;
    delete run.styleId;
    const result = { paragraph, run };
    this.inheritedCache.set(key, result);
    return result;
  }

  /** Resolves a `w:pPr` (possibly null) of a paragraph in a table with the given style, or outside a table. */
  paragraphFromProps(pPr: XmlElement | null, tableStyleId: string | null): ResolvedParagraph {
    const direct = readParagraphProps(pPr);
    const styleId = direct.styleId ?? this.styles.defaultParagraphStyleId;
    const base = this.inherited(styleId, tableStyleId);
    const props: ParagraphProps = { ...base.paragraph };
    if (direct.numId !== undefined && direct.numId !== "0") {
      const level = direct.numLevel ?? props.numLevel ?? 0;
      Object.assign(props, this.numbering.level(direct.numId, level)?.paragraph);
    }
    Object.assign(props, direct);

    const chain = this.styles.chain(styleId);
    const numbering = this.numberingFor(props.numId, props.numLevel, styleId);

    let headingLevel = 0;
    if (props.outlineLevel !== undefined) {
      headingLevel = props.outlineLevel <= 8 ? props.outlineLevel + 1 : 0;
    } else {
      for (let index = chain.length - 1; headingLevel === 0 && index >= 0; index--) {
        headingLevel = headingLevelOfName((chain[index] as { name: string | null }).name);
      }
    }
    const record = styleId === null ? null : this.styles.get(styleId);
    const style: ResolvedParagraphStyle = {
      styleId: record === null ? null : styleId,
      styleName: displayStyleName(record?.name ?? null),
      headingLevel,
      alignment: props.alignment ?? "left",
      indentLeftPt: props.indentLeftPt ?? 0,
      indentRightPt: props.indentRightPt ?? 0,
      firstLineIndentPt: props.firstLineIndentPt ?? 0,
      spacingBeforePt: props.spacingBeforePt ?? 0,
      spacingAfterPt: props.spacingAfterPt ?? 0,
      lineSpacing: props.lineSpacing === undefined ? 1 : props.lineSpacing,
      pageBreakBefore: props.pageBreakBefore ?? false,
      keepWithNext: props.keepWithNext ?? false,
    };
    return { style, runBase: base.run, numbering };
  }

  private numberingFor(
    numId: string | undefined,
    numLevel: number | undefined,
    styleId: string | null,
  ): ResolvedParagraph["numbering"] {
    if (numId === undefined || numId === "0") return null;
    let level = numLevel ?? null;
    const chain = this.styles.chain(styleId);
    for (let index = chain.length - 1; level === null && index >= 0; index--) {
      level = this.numbering.levelForStyle(numId, (chain[index] as { id: string }).id);
    }
    return { numId, level: level ?? 0 };
  }

  /** The numbering instance and level of a paragraph, without resolving the rest of its formatting. */
  numberingOf(paragraph: XmlElement, tableStyleId: string | null): ResolvedParagraph["numbering"] {
    const pPr = firstChild(paragraph, "w:pPr");
    let styleId: string | null = null;
    let numId: string | undefined;
    let numLevel: number | undefined;
    if (pPr !== null) {
      styleId = childVal(pPr, "w:pStyle");
      const numPr = firstChild(pPr, "w:numPr");
      if (numPr !== null) {
        const direct = readParagraphProps(pPr);
        numId = direct.numId;
        numLevel = direct.numLevel;
      }
    }
    styleId ??= this.styles.defaultParagraphStyleId;
    const inherited = this.inherited(styleId, tableStyleId).paragraph;
    return this.numberingFor(numId ?? inherited.numId, numLevel ?? inherited.numLevel, styleId);
  }

  paragraph(paragraph: XmlElement, tableStyleId: string | null): ResolvedParagraph {
    return this.paragraphFromProps(firstChild(paragraph, "w:pPr"), tableStyleId);
  }

  private characterStyle(styleId: string | undefined): RunProps | null {
    if (styleId === undefined) return null;
    let props = this.characterCache.get(styleId);
    if (props === undefined) {
      props = this.styles.runPropsOf(styleId);
      this.characterCache.set(styleId, props);
    }
    return props;
  }

  /** The format of a run with the given `w:rPr` in a paragraph whose runs start from `base`. */
  runFormat(base: RunProps, rPr: XmlElement | null): RunFormat {
    if (rPr === null) return completeRunFormat(base);
    const direct = readRunProps(rPr, this.styles.theme);
    return completeRunFormat({ ...base, ...this.characterStyle(direct.styleId), ...direct });
  }

  /** The run properties that differ between two `w:rPr` elements of the same run. */
  runFormatChange(before: XmlElement | null, after: XmlElement | null): { before: Partial<RunFormat>; after: Partial<RunFormat> } {
    const old = this.runFormat({}, before);
    const current = this.runFormat({}, after);
    const result = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
    for (const key of RUN_FORMAT_KEYS) {
      if (old[key] === current[key]) continue;
      result.before[key] = old[key];
      result.after[key] = current[key];
    }
    return result as { before: Partial<RunFormat>; after: Partial<RunFormat> };
  }

  /** The paragraph properties that differ between two `w:pPr` elements of the same paragraph. */
  paragraphFormatChange(
    before: XmlElement | null,
    after: XmlElement | null,
    tableStyleId: string | null,
  ): { before: Partial<ParagraphStylePatch>; after: Partial<ParagraphStylePatch> } {
    const old = this.paragraphFromProps(before, tableStyleId).style;
    const current = this.paragraphFromProps(after, tableStyleId).style;
    const result = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
    for (const key of PATCH_KEYS) {
      if (old[key] === current[key]) continue;
      result.before[key] = old[key];
      result.after[key] = current[key];
    }
    return result as { before: Partial<ParagraphStylePatch>; after: Partial<ParagraphStylePatch> };
  }
}
