/**
 * CSS for mail content, by allowlist. A declaration survives only when its
 * property is listed, its value is built from plain tokens and listed
 * functions, and it carries no escape, URL or stray syntax. Nothing here
 * decodes CSS escapes: text that needs decoding is dropped.
 */
import { filterSelector } from "./css-selectors";

export interface FilteredCss {
  css: string;
  /** True when a kept declaration sets a text or background colour. */
  hasColor: boolean;
}

export interface DeclarationOptions {
  /**
   * For markup that will sit in the app's own document (a quoted reply in the
   * composer): also drops what could move content over the surrounding UI.
   */
  strict?: boolean;
}

const MAX_STYLE_CHARS = 8000;
/** Below MAX_STYLE_CHARS, so filtering the output again gives the same text. */
const MAX_STYLE_OUTPUT_CHARS = 4000;
const MAX_DECLARATIONS = 80;
const MAX_VALUE_CHARS = 400;
const MAX_SHEET_CHARS = 500_000;
const MAX_SHEET_OUTPUT_CHARS = 100_000;
const MAX_SHEET_RULES = 2000;
const MAX_MEDIA_DEPTH = 3;

const SIDES = ["top", "right", "bottom", "left"];
const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  "color", "background", "background-color", "background-image", "background-position", "background-repeat", "background-size",
  "border", "border-color", "border-style", "border-width", "border-radius", "border-collapse", "border-spacing",
  ...SIDES.flatMap((side) => [`border-${side}`, `border-${side}-color`, `border-${side}-style`, `border-${side}-width`, `margin-${side}`, `padding-${side}`]),
  "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius",
  "margin", "padding", "box-sizing", "box-shadow",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "display", "float", "clear", "vertical-align", "overflow", "overflow-x", "overflow-y", "overflow-wrap", "visibility", "opacity", "position",
  "font", "font-family", "font-size", "font-style", "font-weight", "font-variant", "font-stretch",
  "line-height", "letter-spacing", "word-spacing", "word-break", "word-wrap", "white-space",
  "text-align", "text-decoration", "text-decoration-line", "text-decoration-color", "text-decoration-style",
  "text-indent", "text-transform", "text-overflow", "text-shadow",
  "list-style", "list-style-type", "list-style-position", "table-layout", "caption-side", "empty-cells", "direction",
  "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "justify-content", "align-items", "align-self", "gap", "row-gap", "column-gap",
]);
/** Dropped in strict mode: these can take content out of its box. */
const STRICT_DROPPED: ReadonlySet<string> = new Set(["position", "float", "opacity", "visibility", "overflow", "overflow-x", "overflow-y", "white-space", "box-shadow", "text-shadow"]);
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "rgb", "rgba", "hsl", "hsla", "calc", "min", "max", "clamp",
  "linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient",
]);
const COLOR_PROPERTIES: ReadonlySet<string> = new Set(["color", "background", "background-color"]);
const NOT_A_COLOR = /^(?:transparent|inherit|initial|unset|revert|none|currentcolor)$/i;
const FORBIDDEN_WORDS = /expression|javascript|vbscript|binding|behaviou?r|import/i;
const STRING_CONTENT = /^[\p{L}\p{N} _.,-]*$/u;
const URL_FUNCTION = /url\s*\(\s*(?:"[^"]*"|'[^']*'|[^)'"]*)\s*\)/gi;

/** Removes comments. An unterminated comment takes the rest of the text with it. */
function stripComments(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("/*", at);
    if (open < 0) return out + text.slice(at);
    out += `${text.slice(at, open)} `;
    const close = text.indexOf("*/", open + 2);
    if (close < 0) return out;
    at = close + 2;
  }
}

/** Splits on `;` outside strings and parentheses. A piece that never closes its string or parenthesis is dropped. */
function splitDeclarations(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      pieces.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (!quote && depth === 0) pieces.push(text.slice(start));
  return pieces;
}

/** Checks a value token by token and returns it normalised, or null. */
function checkValue(value: string): string | null {
  let bare = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' || char === "'") {
      const close = value.indexOf(char, index + 1);
      if (close < 0 || !STRING_CONTENT.test(value.slice(index + 1, close))) return null;
      bare += " ";
      index = close;
      continue;
    }
    if (!/[A-Za-z0-9 #%.,()+\-*/_]/.test(char)) return null;
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth < 0) return null;
    }
    bare += char;
  }
  if (depth !== 0 || FORBIDDEN_WORDS.test(bare)) return null;
  for (const match of bare.matchAll(/([A-Za-z_][A-Za-z0-9_-]*|-[A-Za-z_-][A-Za-z0-9_-]*)?\s*\(/g)) {
    // A bare parenthesis groups terms inside calc(); a named one must be a listed function.
    if (match[1] && !ALLOWED_FUNCTIONS.has(match[1].toLowerCase())) return null;
  }
  return value.replace(/\s+/g, " ").trim();
}

function filterDeclaration(piece: string, options: DeclarationOptions): { text: string; color: boolean } | null {
  const colon = piece.indexOf(":");
  if (colon < 0) return null;
  const name = piece.slice(0, colon).trim().toLowerCase();
  if (!ALLOWED_PROPERTIES.has(name)) return null;
  if (options.strict && STRICT_DROPPED.has(name)) return null;
  let raw = piece.slice(colon + 1).trim();
  if (!raw || raw.length > MAX_VALUE_CHARS) return null;
  const important = /!\s*important$/i.test(raw);
  if (important) raw = raw.replace(/!\s*important$/i, "").trim();
  if (name === "background" || name === "background-image") raw = raw.replace(URL_FUNCTION, " ").trim();
  if (!raw) return null;
  const value = checkValue(raw);
  if (!value) return null;
  if (name === "position" && !/^(?:static|relative)$/i.test(value)) return null;
  if (options.strict && /(?:^|[\s,(])-\.?\d/.test(value)) return null;
  return { text: `${name}:${value}${important ? " !important" : ""}`, color: COLOR_PROPERTIES.has(name) && !NOT_A_COLOR.test(value) };
}

/** Filters the text of a `style` attribute or of one rule's block. */
export function filterDeclarations(text: unknown, options: DeclarationOptions = {}): FilteredCss {
  if (typeof text !== "string" || !text) return { css: "", hasColor: false };
  const clean = stripComments(text.slice(0, MAX_STYLE_CHARS)).replace(/\s/g, " ");
  const kept: string[] = [];
  let hasColor = false;
  let length = 0;
  for (const piece of splitDeclarations(clean)) {
    if (kept.length >= MAX_DECLARATIONS) break;
    const declaration = filterDeclaration(piece, options);
    if (!declaration) continue;
    length += declaration.text.length + 1;
    if (length > MAX_STYLE_OUTPUT_CHARS) break;
    kept.push(declaration.text);
    hasColor ||= declaration.color;
  }
  return { css: kept.join(";"), hasColor };
}

/** Index of the `}` that closes the block opened at `open`, or -1. Strings may hide braces. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function filterMediaQuery(prelude: string): string | null {
  const query = prelude.replace(/\s+/g, " ").trim();
  if (!query || query.length > 200 || !/^[A-Za-z0-9 ():,.\-/]+$/.test(query) || /[A-Za-z0-9_-]\(/.test(query)) return null;
  return query;
}

interface SheetBudget {
  rules: number;
  chars: number;
  hasColor: boolean;
}

function filterRules(text: string, depth: number, budget: SheetBudget): string {
  let out = "";
  let at = 0;
  while (at < text.length && budget.rules < MAX_SHEET_RULES && budget.chars < MAX_SHEET_OUTPUT_CHARS) {
    const char = text[at];
    if (char === "}" || char === ";" || /\s/.test(char)) {
      at += 1;
      continue;
    }
    const semicolon = text.indexOf(";", at);
    const open = text.indexOf("{", at);
    if (open < 0) break;
    if (text[at] === "@" && semicolon >= 0 && semicolon < open) {
      // A statement at-rule such as @import or @charset: never kept.
      at = semicolon + 1;
      continue;
    }
    const close = matchingBrace(text, open);
    if (close < 0) break;
    const prelude = text.slice(at, open).trim();
    const block = text.slice(open + 1, close);
    at = close + 1;
    let rule = "";
    if (prelude.startsWith("@")) {
      const media = /^@media(?![A-Za-z0-9_-])\s*(.+)$/is.exec(prelude);
      const query = media && depth < MAX_MEDIA_DEPTH ? filterMediaQuery(media[1]) : null;
      const inner = query ? filterRules(block, depth + 1, budget) : "";
      if (query && inner) rule = `@media ${query}{${inner}}`;
    } else {
      const selector = filterSelector(prelude);
      const declarations = selector ? filterDeclarations(block) : null;
      if (selector && declarations?.css) {
        rule = `${selector}{${declarations.css}}`;
        budget.hasColor ||= declarations.hasColor;
        budget.rules += 1;
      }
    }
    if (rule && budget.chars + rule.length <= MAX_SHEET_OUTPUT_CHARS) {
      out += rule;
      if (depth === 0) budget.chars += rule.length;
    }
  }
  return out;
}

/**
 * Filters the text of a `<style>` element. Keeps plain style rules and
 * `@media` blocks; drops every other at-rule. The result contains no `<`, so
 * it cannot close the style element it is written into.
 */
export function filterStylesheet(text: unknown): FilteredCss {
  if (typeof text !== "string" || !text) return { css: "", hasColor: false };
  const clean = stripComments(text.slice(0, MAX_SHEET_CHARS)).replace(/<!--|-->/g, " ").replace(/\s/g, " ");
  const budget: SheetBudget = { rules: 0, chars: 0, hasColor: false };
  const css = filterRules(clean, 0, budget);
  return css.includes("<") ? { css: "", hasColor: false } : { css, hasColor: budget.hasColor };
}
