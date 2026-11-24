/**
 * The style table (`xl/styles.xml`): cell formats, fonts, fills, borders
 * and number formats, resolved to the plain {@link CellStyle} of the contract.
 */

import type {
  AlignmentStyle,
  BorderEdge,
  BorderLineStyle,
  BorderStyle,
  CellStyle,
  FillStyle,
  FontStyle,
  StyleId,
} from "../../api/xlsx.js";
import type { XmlDocument, XmlElement } from "../../api/xml.js";
import { getAttr } from "../../xml/index.js";
import { builtinFormatCode } from "../format/builtin.js";
import { type Palette, readIndexedColors, resolveColor } from "./colors.js";
import { boolAttr, kid, kids } from "./xml-util.js";

const LINE_STYLES: Readonly<Record<string, BorderLineStyle>> = {
  none: "none",
  thin: "thin",
  medium: "medium",
  thick: "thick",
  dashed: "dashed",
  dotted: "dotted",
  double: "double",
  hair: "hair",
  mediumDashed: "dashed",
  dashDot: "dashed",
  mediumDashDot: "dashed",
  dashDotDot: "dashed",
  mediumDashDotDot: "dashed",
  slantDashDot: "dashed",
};

const DEFAULT_FONT: FontStyle = Object.freeze({
  name: "Calibri",
  sizePt: 11,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: null,
});

function flag(font: XmlElement, local: string): boolean {
  const element = kid(font, local);
  return element !== null && boolAttr(getAttr(element, "val"), true);
}

export function readFont(font: XmlElement | undefined, palette: Palette): FontStyle {
  if (font === undefined) return { ...DEFAULT_FONT };
  const name = kid(font, "name");
  const size = kid(font, "sz");
  const underline = kid(font, "u");
  const sizePt = size === null ? Number.NaN : Number(getAttr(size, "val"));
  return {
    name: (name === null ? null : getAttr(name, "val")) ?? DEFAULT_FONT.name,
    sizePt: Number.isFinite(sizePt) && sizePt > 0 ? sizePt : DEFAULT_FONT.sizePt,
    bold: flag(font, "b"),
    italic: flag(font, "i"),
    underline: underline !== null && getAttr(underline, "val") !== "none",
    strike: flag(font, "strike"),
    color: resolveColor(kid(font, "color"), palette),
  };
}

export function readFill(fill: XmlElement | undefined, palette: Palette): FillStyle {
  const pattern = fill === undefined ? null : kid(fill, "patternFill");
  if (pattern === null) return { color: null };
  const type = getAttr(pattern, "patternType");
  if (type === null || type === "none") return { color: null };
  return { color: resolveColor(kid(pattern, "fgColor"), palette) };
}

function readEdge(border: XmlElement | undefined, local: string, palette: Palette): BorderEdge {
  // Older files name the side edges `start` and `end`.
  const edge = border === undefined ? null : (kid(border, local) ?? (local === "left" ? kid(border, "start") : local === "right" ? kid(border, "end") : null));
  if (edge === null) return { style: "none", color: null };
  const style = LINE_STYLES[getAttr(edge, "style") ?? "none"] ?? "thin";
  return { style, color: style === "none" ? null : resolveColor(kid(edge, "color"), palette) };
}

export function readBorder(border: XmlElement | undefined, palette: Palette): BorderStyle {
  return {
    top: readEdge(border, "top", palette),
    right: readEdge(border, "right", palette),
    bottom: readEdge(border, "bottom", palette),
    left: readEdge(border, "left", palette),
  };
}

export function readAlignment(xf: XmlElement | undefined): AlignmentStyle {
  const alignment = xf === undefined ? null : kid(xf, "alignment");
  const style: AlignmentStyle = { horizontal: "general", vertical: "bottom", wrapText: false, indent: 0 };
  if (alignment === null) return style;
  const horizontal = getAttr(alignment, "horizontal");
  if (horizontal === "left" || horizontal === "center" || horizontal === "right" || horizontal === "justify") {
    style.horizontal = horizontal;
  } else if (horizontal === "centerContinuous") style.horizontal = "center";
  else if (horizontal === "distributed") style.horizontal = "justify";
  const vertical = getAttr(alignment, "vertical");
  if (vertical === "top") style.vertical = "top";
  else if (vertical === "center" || vertical === "justify" || vertical === "distributed") style.vertical = "middle";
  style.wrapText = boolAttr(getAttr(alignment, "wrapText"), false);
  const indent = Number(getAttr(alignment, "indent") ?? "0");
  style.indent = Number.isInteger(indent) && indent > 0 ? indent : 0;
  return style;
}

function intAttr(element: XmlElement | undefined, name: string): number {
  if (element === undefined) return 0;
  const value = Number(getAttr(element, name) ?? "0");
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The record lists of a style sheet. The write half in `style-write.ts` appends to them. */
export class StyleTable {
  readonly doc: XmlDocument;
  readonly palette: Palette;
  dirty = false;
  /** Custom number formats by id. Holds the formats of the file plus those added through `setStyle`. */
  readonly numFmts = new Map<number, string>();
  fonts: XmlElement[];
  fills: XmlElement[];
  borders: XmlElement[];
  xfs: XmlElement[];
  /** Number format code per cell format, filled on demand. */
  private readonly formatCodes: (string | undefined)[] = [];
  private readonly resolved: (CellStyle | undefined)[] = [];

  constructor(doc: XmlDocument, themeColors: readonly string[]) {
    this.doc = doc;
    const root = doc.root;
    this.palette = { theme: themeColors, indexed: readIndexedColors(root) };
    const numFmts = kid(root, "numFmts");
    if (numFmts !== null) {
      for (const entry of kids(numFmts, "numFmt")) {
        const id = Number(getAttr(entry, "numFmtId"));
        const code = getAttr(entry, "formatCode");
        if (Number.isInteger(id) && code !== null) this.numFmts.set(id, code);
      }
    }
    this.fonts = this.list("fonts", "font");
    this.fills = this.list("fills", "fill");
    this.borders = this.list("borders", "border");
    this.xfs = this.list("cellXfs", "xf");
  }

  private list(container: string, item: string): XmlElement[] {
    const element = kid(this.doc.root, container);
    return element === null ? [] : kids(element, item);
  }

  get count(): number {
    return Math.max(1, this.xfs.length);
  }

  /** A style id as stored in a cell, clamped to the table. */
  clamp(styleId: StyleId): StyleId {
    return Number.isInteger(styleId) && styleId > 0 && styleId < this.xfs.length ? styleId : 0;
  }

  formatCodeOfId(numFmtId: number): string {
    return this.numFmts.get(numFmtId) ?? builtinFormatCode(numFmtId) ?? "General";
  }

  /** The number format code of a cell format. */
  numberFormat(styleId: StyleId): string {
    const id = this.clamp(styleId);
    let code = this.formatCodes[id];
    if (code === undefined) {
      code = this.formatCodeOfId(intAttr(this.xfs[id], "numFmtId"));
      this.formatCodes[id] = code;
    }
    return code;
  }

  /** The complete format of a style id, as a fresh object. */
  getStyle(styleId: StyleId): CellStyle {
    const id = this.clamp(styleId);
    let style = this.resolved[id];
    if (style === undefined) {
      const xf = this.xfs[id];
      style = {
        font: readFont(this.fonts[intAttr(xf, "fontId")], this.palette),
        fill: readFill(this.fills[intAttr(xf, "fillId")], this.palette),
        border: readBorder(this.borders[intAttr(xf, "borderId")], this.palette),
        alignment: readAlignment(xf),
        numberFormat: this.numberFormat(id),
      };
      this.resolved[id] = style;
    }
    return {
      font: { ...style.font },
      fill: { ...style.fill },
      border: {
        top: { ...style.border.top },
        right: { ...style.border.right },
        bottom: { ...style.border.bottom },
        left: { ...style.border.left },
      },
      alignment: { ...style.alignment },
      numberFormat: style.numberFormat,
    };
  }
}
