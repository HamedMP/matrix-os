/**
 * Readers for run properties (`w:rPr`) and paragraph properties (`w:pPr`).
 *
 * A reader returns only the properties its element sets. Layers (document
 * defaults, style chain, direct formatting) are merged with `Object.assign`,
 * so a later layer overrides exactly what it specifies.
 */

import type { ParagraphAlignment, RunFormat } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { attr, childToggle, childVal, firstChild, intAttr, twipsToPt } from "./names.js";

export interface RunProps extends Partial<RunFormat> {
  /** `w:rStyle`: the character style of the run. */
  styleId?: string;
}

export interface ParagraphProps {
  styleId?: string;
  alignment?: ParagraphAlignment;
  indentLeftPt?: number;
  indentRightPt?: number;
  firstLineIndentPt?: number;
  spacingBeforePt?: number;
  spacingAfterPt?: number;
  lineSpacing?: number | null;
  pageBreakBefore?: boolean;
  keepWithNext?: boolean;
  /** `w:outlineLvl`: 0 to 8 for a heading, 9 for body text. */
  outlineLevel?: number;
  /** `w:numPr/w:numId`; `"0"` switches numbering off. */
  numId?: string;
  /** `w:numPr/w:ilvl`. */
  numLevel?: number;
}

/** Latin fonts of the document theme. */
export interface ThemeFonts {
  readonly major: string | null;
  readonly minor: string | null;
}

const HIGHLIGHT_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  green: "#00ff00",
  magenta: "#ff00ff",
  red: "#ff0000",
  yellow: "#ffff00",
  white: "#ffffff",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
};

/** `RRGGBB` to `#rrggbb`; null for `auto` and for anything that is not a colour. */
export function hexColor(value: string | null): string | null {
  if (value === null || !/^[0-9A-Fa-f]{6}$/.test(value)) return null;
  return `#${value.toLowerCase()}`;
}

function themeFont(reference: string | null, theme: ThemeFonts | null): string | null {
  if (reference === null || theme === null) return null;
  if (reference.startsWith("major")) return theme.major;
  if (reference.startsWith("minor")) return theme.minor;
  return null;
}

export function readRunProps(rPr: XmlElement | null, theme: ThemeFonts | null): RunProps {
  const props: RunProps = {};
  if (rPr === null) return props;
  for (const node of rPr.children) {
    if (node.kind !== "element") continue;
    switch (node.name) {
      case "w:rStyle": {
        const value = attr(node, "w:val");
        if (value !== null) props.styleId = value;
        break;
      }
      case "w:b":
        props.bold = childToggle(rPr, "w:b") ?? true;
        break;
      case "w:i":
        props.italic = childToggle(rPr, "w:i") ?? true;
        break;
      case "w:strike":
      case "w:dstrike":
        props.strike = (childToggle(rPr, node.name) ?? true) || props.strike === true;
        break;
      case "w:u": {
        const value = attr(node, "w:val");
        props.underline = value !== "none" && value !== null;
        break;
      }
      case "w:color": {
        const value = attr(node, "w:val");
        props.color = hexColor(value);
        break;
      }
      case "w:highlight": {
        const value = attr(node, "w:val");
        props.highlight = value === null ? null : (HIGHLIGHT_COLORS[value] ?? null);
        break;
      }
      case "w:shd": {
        // Character shading shows like a highlight; an explicit highlight wins.
        if (firstChild(rPr, "w:highlight") === null) props.highlight = hexColor(attr(node, "w:fill"));
        break;
      }
      case "w:sz": {
        const value = intAttr(node, "w:val");
        if (value !== null && value > 0) props.fontSizePt = value / 2;
        break;
      }
      case "w:rFonts": {
        const family =
          attr(node, "w:ascii") ??
          themeFont(attr(node, "w:asciiTheme"), theme) ??
          attr(node, "w:hAnsi") ??
          themeFont(attr(node, "w:hAnsiTheme"), theme) ??
          attr(node, "w:cs") ??
          attr(node, "w:eastAsia");
        if (family !== null) props.fontFamily = family;
        break;
      }
      case "w:vertAlign": {
        const value = attr(node, "w:val");
        props.verticalAlign = value === "superscript" || value === "subscript" ? value : "baseline";
        break;
      }
      default:
        break;
    }
  }
  return props;
}

function alignmentOf(value: string | null): ParagraphAlignment | null {
  switch (value) {
    case "left":
    case "start":
      return "left";
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "both":
    case "distribute":
    case "justify":
      return "justify";
    default:
      return null;
  }
}

export function readParagraphProps(pPr: XmlElement | null): ParagraphProps {
  const props: ParagraphProps = {};
  if (pPr === null) return props;
  for (const node of pPr.children) {
    if (node.kind !== "element") continue;
    switch (node.name) {
      case "w:pStyle": {
        const value = attr(node, "w:val");
        if (value !== null) props.styleId = value;
        break;
      }
      case "w:jc": {
        const alignment = alignmentOf(attr(node, "w:val"));
        if (alignment !== null) props.alignment = alignment;
        break;
      }
      case "w:ind": {
        const left = intAttr(node, "w:left") ?? intAttr(node, "w:start");
        const right = intAttr(node, "w:right") ?? intAttr(node, "w:end");
        const hanging = intAttr(node, "w:hanging");
        const firstLine = intAttr(node, "w:firstLine");
        if (left !== null) props.indentLeftPt = twipsToPt(left);
        if (right !== null) props.indentRightPt = twipsToPt(right);
        if (hanging !== null) props.firstLineIndentPt = -twipsToPt(hanging);
        else if (firstLine !== null) props.firstLineIndentPt = twipsToPt(firstLine);
        break;
      }
      case "w:spacing": {
        const before = intAttr(node, "w:before");
        const after = intAttr(node, "w:after");
        const line = intAttr(node, "w:line");
        if (before !== null) props.spacingBeforePt = twipsToPt(before);
        if (after !== null) props.spacingAfterPt = twipsToPt(after);
        if (line !== null) {
          const rule = attr(node, "w:lineRule");
          props.lineSpacing = rule === null || rule === "auto" ? line / 240 : null;
        }
        break;
      }
      case "w:pageBreakBefore":
        props.pageBreakBefore = childToggle(pPr, "w:pageBreakBefore") ?? true;
        break;
      case "w:keepNext":
        props.keepWithNext = childToggle(pPr, "w:keepNext") ?? true;
        break;
      case "w:outlineLvl": {
        const value = intAttr(node, "w:val");
        if (value !== null && value >= 0 && value <= 9) props.outlineLevel = value;
        break;
      }
      case "w:numPr": {
        const numId = childVal(node, "w:numId");
        const level = firstChild(node, "w:ilvl");
        if (numId !== null) props.numId = numId;
        const value = level === null ? null : intAttr(level, "w:val");
        if (value !== null && value >= 0 && value <= 8) props.numLevel = value;
        break;
      }
      default:
        break;
    }
  }
  return props;
}

/** A complete run format: `props` over the defaults for anything it leaves open. */
export function completeRunFormat(props: RunProps): RunFormat {
  return {
    bold: props.bold ?? false,
    italic: props.italic ?? false,
    underline: props.underline ?? false,
    strike: props.strike ?? false,
    color: props.color ?? null,
    highlight: props.highlight ?? null,
    fontSizePt: props.fontSizePt ?? null,
    fontFamily: props.fontFamily ?? null,
    verticalAlign: props.verticalAlign ?? "baseline",
  };
}

export const RUN_FORMAT_KEYS: ReadonlyArray<keyof RunFormat> = [
  "bold",
  "italic",
  "underline",
  "strike",
  "color",
  "highlight",
  "fontSizePt",
  "fontFamily",
  "verticalAlign",
];
