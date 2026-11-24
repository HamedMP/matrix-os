/** Colour resolution: `rgb`, theme with tint, and indexed colours to `#rrggbb`. */

import type { XmlDocument, XmlElement } from "../../api/xml.js";
import { findAll, getAttr } from "../../xml/index.js";
import { INDEXED_COLORS } from "../format/palette.js";
import { isNamed, kid } from "./xml-util.js";

/** The colours of the default theme, in the order a `theme` attribute indexes them. */
export const DEFAULT_THEME_COLORS: readonly string[] = Object.freeze([
  "#ffffff",
  "#000000",
  "#e7e6e6",
  "#44546a",
  "#4472c4",
  "#ed7d31",
  "#a5a5a5",
  "#ffc000",
  "#5b9bd5",
  "#70ad47",
  "#0563c1",
  "#954f72",
]);

/** Order of the colours inside `a:clrScheme`, and the theme index of each. */
const SCHEME_ORDER = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
const SCHEME_TO_INDEX = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11];

function normalizeHex(value: string | null): string | null {
  if (value === null) return null;
  const hex = value.length === 8 ? value.slice(2) : value;
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : null;
}

/** Reads the twelve theme colours of a theme part. Missing ones keep the default. */
export function readThemeColors(theme: XmlDocument | null): string[] {
  const colors = [...DEFAULT_THEME_COLORS];
  if (theme === null) return colors;
  let scheme: XmlElement | null = null;
  for (const element of findAll(theme, theme.root.name.replace(/[^:]*$/, "clrScheme"))) {
    scheme = element;
    break;
  }
  if (scheme === null) return colors;
  for (const entry of scheme.children) {
    if (entry.kind !== "element") continue;
    const slot = SCHEME_ORDER.findIndex((name) => isNamed(entry.name, name));
    if (slot < 0) continue;
    const srgb = kid(entry, "srgbClr");
    const sys = kid(entry, "sysClr");
    const color = normalizeHex(srgb !== null ? getAttr(srgb, "val") : sys !== null ? getAttr(sys, "lastClr") : null);
    if (color !== null) colors[SCHEME_TO_INDEX[slot] as number] = color;
  }
  return colors;
}

/** Lightens (tint above 0) or darkens (below 0) a colour the way a theme tint does. */
export function applyTint(color: string, tint: number): string {
  if (!Number.isFinite(tint) || tint === 0) return color;
  const amount = Math.max(-1, Math.min(1, tint));
  let out = "#";
  for (let i = 1; i < 7; i += 2) {
    const channel = Number.parseInt(color.slice(i, i + 2), 16);
    const moved = amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount;
    out += Math.round(moved).toString(16).padStart(2, "0");
  }
  return out;
}

export interface Palette {
  theme: readonly string[];
  indexed: readonly string[];
}

/** Reads a custom indexed palette from `styles.xml`, or returns the default one. */
export function readIndexedColors(styleSheet: XmlElement | null): readonly string[] {
  const colors = styleSheet === null ? null : kid(styleSheet, "colors");
  const indexed = colors === null ? null : kid(colors, "indexedColors");
  if (indexed === null) return INDEXED_COLORS;
  const palette: string[] = [];
  for (const entry of indexed.children) {
    if (entry.kind !== "element") continue;
    palette.push(normalizeHex(getAttr(entry, "rgb")) ?? "#000000");
    if (palette.length >= 256) break;
  }
  return palette.length === 0 ? INDEXED_COLORS : palette;
}

/** Resolves a colour element (`<color>`, `<fgColor>`) to `#rrggbb`, or null for automatic. */
export function resolveColor(element: XmlElement | null, palette: Palette): string | null {
  if (element === null) return null;
  const rgb = normalizeHex(getAttr(element, "rgb"));
  if (rgb !== null) return rgb;
  const theme = getAttr(element, "theme");
  if (theme !== null) {
    const base = palette.theme[Number(theme)];
    if (base === undefined) return null;
    const tint = getAttr(element, "tint");
    return tint === null ? base : applyTint(base, Number(tint));
  }
  const indexed = getAttr(element, "indexed");
  if (indexed !== null) {
    const index = Number(indexed);
    // 64 and 65 are the system foreground and background: automatic.
    return index >= 64 ? null : (palette.indexed[index] ?? null);
  }
  return null;
}

/** `#rrggbb` as the opaque `AARRGGBB` a file stores. */
export function toArgb(color: string): string {
  return `FF${color.slice(1).toUpperCase()}`;
}

/** True for `#rrggbb`. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
