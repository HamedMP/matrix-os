/**
 * Number format codes, split into sections and tokens.
 *
 * A code has up to four sections separated by `;` (positive; negative; zero;
 * text). Each section is a list of tokens: digit placeholders, literals,
 * date and time parts. Parsing never throws: anything it does not understand
 * becomes a literal or is dropped, because format codes come from files.
 */

import { INDEXED_COLORS } from "./palette.js";

export type FormatToken =
  | { t: "lit"; v: string }
  | { t: "digit"; v: "0" | "#" | "?" }
  | { t: "point" }
  | { t: "comma" }
  | { t: "percent" }
  | { t: "exp"; plus: boolean }
  | { t: "slash" }
  | { t: "text" }
  | { t: "general" }
  /** `y`, `m`, `d`, `h`, `s` runs (lower case, `v` is the run), and `n` for minutes once resolved. */
  | { t: "date"; unit: "y" | "m" | "d" | "h" | "n" | "s"; width: number }
  | { t: "ampm"; short: boolean }
  | { t: "elapsed"; unit: "h" | "m" | "s"; width: number }
  | { t: "subsec"; digits: number };

export type SectionKind = "number" | "date" | "text" | "general" | "literal" | "empty";

export interface FormatCondition {
  op: "<" | "<=" | ">" | ">=" | "=" | "<>";
  value: number;
}

export interface FormatSection {
  kind: SectionKind;
  tokens: FormatToken[];
  /** `#rrggbb`, or null when the section names no colour. */
  color: string | null;
  condition: FormatCondition | null;
}

export interface ParsedFormat {
  sections: FormatSection[];
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  green: "#00ff00",
  magenta: "#ff00ff",
  red: "#ff0000",
  white: "#ffffff",
  yellow: "#ffff00",
};

/** Longest format code that is parsed; longer codes are cut. */
const MAX_CODE_LENGTH = 1024;
const CACHE_LIMIT = 512;
/** Parsed codes. Cleared when it reaches {@link CACHE_LIMIT} entries. */
const cache = new Map<string, ParsedFormat>();

interface RawSection {
  tokens: FormatToken[];
  color: string | null;
  condition: FormatCondition | null;
}

function pushLiteral(tokens: FormatToken[], text: string): void {
  if (text === "") return;
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.t === "lit") last.v += text;
  else tokens.push({ t: "lit", v: text });
}

/** Handles the content of `[...]`. */
function applyBracket(section: RawSection, content: string): void {
  const lower = content.toLowerCase();
  if (/^(h+|m+|s+)$/.test(lower)) {
    section.tokens.push({ t: "elapsed", unit: lower.charAt(0) as "h" | "m" | "s", width: lower.length });
    return;
  }
  const named = NAMED_COLORS[lower];
  if (named !== undefined) {
    section.color = named;
    return;
  }
  const indexed = /^color\s*(\d{1,2})$/.exec(lower);
  if (indexed !== null) {
    const color = INDEXED_COLORS[Number(indexed[1]) + 7];
    if (color !== undefined) section.color = color;
    return;
  }
  const condition = /^(<=|>=|<>|=|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(content.trim());
  if (condition !== null) {
    section.condition = { op: condition[1] as FormatCondition["op"], value: Number(condition[2]) };
    return;
  }
  if (content.startsWith("$")) {
    // `[$€-407]`: the currency text up to the locale tag.
    const dash = content.indexOf("-");
    pushLiteral(section.tokens, dash < 0 ? content.slice(1) : content.slice(1, dash));
  }
  // Anything else (`[DBNum1]`, locale tags) has no effect on the text.
}

function tokenize(code: string): RawSection[] {
  const sections: RawSection[] = [];
  let section: RawSection = { tokens: [], color: null, condition: null };
  const length = code.length;
  let i = 0;
  while (i < length) {
    const ch = code.charAt(i);
    if (ch === ";") {
      sections.push(section);
      section = { tokens: [], color: null, condition: null };
      i++;
    } else if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      pushLiteral(section.tokens, code.slice(i + 1, end < 0 ? length : end));
      i = end < 0 ? length : end + 1;
    } else if (ch === "\\") {
      pushLiteral(section.tokens, code.charAt(i + 1));
      i += 2;
    } else if (ch === "_") {
      if (i + 1 < length) pushLiteral(section.tokens, " ");
      i += 2;
    } else if (ch === "*") {
      i += 2;
    } else if (ch === "[") {
      const end = code.indexOf("]", i + 1);
      if (end < 0) {
        i = length;
      } else {
        applyBracket(section, code.slice(i + 1, end));
        i = end + 1;
      }
    } else if (ch === "0" || ch === "#" || ch === "?") {
      section.tokens.push({ t: "digit", v: ch });
      i++;
    } else if (ch === ".") {
      section.tokens.push({ t: "point" });
      i++;
    } else if (ch === ",") {
      section.tokens.push({ t: "comma" });
      i++;
    } else if (ch === "%") {
      section.tokens.push({ t: "percent" });
      i++;
    } else if (ch === "/") {
      section.tokens.push({ t: "slash" });
      i++;
    } else if (ch === "@") {
      section.tokens.push({ t: "text" });
      i++;
    } else if ((ch === "E" || ch === "e") && (code.charAt(i + 1) === "+" || code.charAt(i + 1) === "-")) {
      section.tokens.push({ t: "exp", plus: code.charAt(i + 1) === "+" });
      i += 2;
    } else if ((ch === "G" || ch === "g") && code.slice(i, i + 7).toLowerCase() === "general") {
      section.tokens.push({ t: "general" });
      i += 7;
    } else if ((ch === "A" || ch === "a") && code.slice(i, i + 5).toLowerCase() === "am/pm") {
      section.tokens.push({ t: "ampm", short: false });
      i += 5;
    } else if ((ch === "A" || ch === "a") && code.slice(i, i + 3).toLowerCase() === "a/p") {
      section.tokens.push({ t: "ampm", short: true });
      i += 3;
    } else {
      const lower = ch.toLowerCase();
      if (lower === "y" || lower === "m" || lower === "d" || lower === "h" || lower === "s") {
        let end = i + 1;
        while (end < length && code.charAt(end).toLowerCase() === lower) end++;
        section.tokens.push({ t: "date", unit: lower, width: end - i });
        i = end;
      } else {
        pushLiteral(section.tokens, ch);
        i++;
      }
    }
  }
  sections.push(section);
  return sections;
}

function isDateToken(token: FormatToken): boolean {
  return token.t === "date" || token.t === "ampm" || token.t === "elapsed";
}

/** In a date section: decides month or minute for each `m`, finds fractional seconds, and turns numeric tokens into text. */
function finishDateSection(tokens: FormatToken[]): FormatToken[] {
  const out: FormatToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as FormatToken;
    if (token.t === "point") {
      let digits = 0;
      while (tokens[i + 1 + digits]?.t === "digit" && (tokens[i + 1 + digits] as { v: string }).v === "0") digits++;
      const previous = out[out.length - 1];
      const afterSeconds =
        previous !== undefined &&
        ((previous.t === "date" && previous.unit === "s") || (previous.t === "elapsed" && previous.unit === "s"));
      if (digits > 0 && afterSeconds) {
        out.push({ t: "subsec", digits: Math.min(digits, 3) });
        i += digits;
      } else {
        pushLiteral(out, ".");
      }
    } else if (token.t === "comma") pushLiteral(out, ",");
    else if (token.t === "slash") pushLiteral(out, "/");
    else if (token.t === "percent") pushLiteral(out, "%");
    else if (token.t === "digit") pushLiteral(out, token.v === "0" ? "0" : "");
    else if (token.t === "exp") pushLiteral(out, token.plus ? "E+" : "E-");
    else if (token.t === "text" || token.t === "general") continue;
    else if (token.t === "lit") pushLiteral(out, token.v);
    else out.push(token);
  }
  // `m` is minutes right after hours or right before seconds.
  const parts = out.filter(isDateToken);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as FormatToken;
    if (part.t !== "date" || part.unit !== "m" || part.width > 2) continue;
    const before = parts[i - 1];
    const after = parts[i + 1];
    const afterHours =
      before !== undefined && ((before.t === "date" && before.unit === "h") || (before.t === "elapsed" && before.unit === "h"));
    const beforeSeconds = after !== undefined && after.t === "date" && after.unit === "s";
    if (afterHours || beforeSeconds) part.unit = "n";
  }
  return out;
}

function classify(raw: RawSection): FormatSection {
  let kind: SectionKind;
  let tokens = raw.tokens;
  if (tokens.length === 0) kind = "empty";
  else if (tokens.some(isDateToken)) {
    kind = "date";
    tokens = finishDateSection(tokens);
  } else if (tokens.some((token) => token.t === "general")) kind = "general";
  else if (tokens.some((token) => token.t === "digit")) kind = "number";
  else if (tokens.some((token) => token.t === "text")) kind = "text";
  else kind = "literal";
  return { kind, tokens, color: raw.color, condition: raw.condition };
}

/** Parses a format code. Results are cached; the returned object must not be changed. */
export function parseFormatCode(code: string): ParsedFormat {
  const cached = cache.get(code);
  if (cached !== undefined) return cached;
  const text = code.length > MAX_CODE_LENGTH ? code.slice(0, MAX_CODE_LENGTH) : code;
  const sections = tokenize(text).slice(0, 4).map(classify);
  const parsed: ParsedFormat = { sections };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(code, parsed);
  return parsed;
}

function conditionHolds(condition: FormatCondition, value: number): boolean {
  switch (condition.op) {
    case "<":
      return value < condition.value;
    case "<=":
      return value <= condition.value;
    case ">":
      return value > condition.value;
    case ">=":
      return value >= condition.value;
    case "=":
      return value === condition.value;
    case "<>":
      return value !== condition.value;
  }
}

export interface ChosenSection {
  section: FormatSection;
  /** True when the section shows the magnitude only (the negative section of a multi-section code). */
  absolute: boolean;
}

/** The section that formats a number. Null when the code hides the value (no section applies). */
export function chooseNumberSection(format: ParsedFormat, value: number): ChosenSection | null {
  const sections = format.sections;
  const first = sections[0] as FormatSection;
  const second = sections[1];
  const third = sections[2];
  if (first.condition !== null || (second !== undefined && second.condition !== null)) {
    if (first.condition === null ? value > 0 : conditionHolds(first.condition, value)) {
      return { section: first, absolute: false };
    }
    if (second === undefined) return null;
    if (second.condition === null ? third === undefined || value < 0 : conditionHolds(second.condition, value)) {
      return { section: second, absolute: second.condition === null && value < 0 };
    }
    return third === undefined ? null : { section: third, absolute: false };
  }
  if (second === undefined) return { section: first, absolute: false };
  if (third === undefined || sections.length === 2) {
    return value < 0 ? { section: second, absolute: true } : { section: first, absolute: false };
  }
  if (value > 0) return { section: first, absolute: false };
  if (value < 0) return { section: second, absolute: true };
  return { section: third, absolute: false };
}

/** The section that formats text, or null when text is shown as it is. */
export function chooseTextSection(format: ParsedFormat): FormatSection | null {
  const sections = format.sections;
  const fourth = sections[3];
  if (fourth !== undefined) return fourth;
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i] as FormatSection;
    if (section.kind === "text") return section;
  }
  return null;
}
