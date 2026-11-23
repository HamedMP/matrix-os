/**
 * Resolves `@media` blocks for the measuring copy.
 *
 * Inside the message frame a media query is answered by the frame's own
 * width. The measuring copy sits in the app's document, where the same query
 * would be answered by the app window instead, and a responsive mail would be
 * measured with the wrong layout. So for the copy each `@media` block is
 * evaluated here against the frame's width: its rules are kept without the
 * wrapper when it matches and dropped when it does not.
 *
 * The input is always a stylesheet written by `filterStylesheet`: plain rules
 * and `@media` blocks, balanced, without strings that contain braces.
 */

export interface MediaEnvironment {
  /** Width of the message frame in CSS pixels. */
  width: number;
  /** Width of the screen in CSS pixels. */
  deviceWidth: number;
  scheme: "light" | "dark";
}

const PIXELS_PER_UNIT: Readonly<Record<string, number>> = { px: 1, em: 16, rem: 16, pt: 4 / 3 };

function lengthInPixels(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(px|em|rem|pt)?$/.exec(value.trim());
  if (!match) return null;
  if (!match[2]) return Number(match[1]) === 0 ? 0 : null;
  return Number(match[1]) * PIXELS_PER_UNIT[match[2]];
}

/** Answers one `(feature: value)` test; null when the feature is not one this module understands. */
function featureMatches(feature: string, value: string, environment: MediaEnvironment): boolean | null {
  const length = lengthInPixels(value);
  switch (feature) {
    case "min-width":
      return length === null ? null : environment.width >= length;
    case "max-width":
      return length === null ? null : environment.width <= length;
    case "min-device-width":
      return length === null ? null : environment.deviceWidth >= length;
    case "max-device-width":
      return length === null ? null : environment.deviceWidth <= length;
    case "prefers-color-scheme":
      return value.trim() === environment.scheme;
    default:
      return null;
  }
}

function singleQueryMatches(query: string, environment: MediaEnvironment): boolean {
  const parts = query.trim().toLowerCase().split(/\s+and\s+/);
  let negate = false;
  let result = true;
  for (let index = 0; index < parts.length; index += 1) {
    let part = parts[index].trim();
    if (index === 0) {
      if (part.startsWith("not ")) {
        negate = true;
        part = part.slice(4).trim();
      } else if (part.startsWith("only ")) part = part.slice(5).trim();
    }
    const feature = /^\(\s*([a-z-]+)\s*:\s*([^()]+)\)$/.exec(part);
    const answer = feature ? featureMatches(feature[1], feature[2], environment) : part === "screen" || part === "all" ? true : part === "print" || part === "speech" ? false : null;
    // A query this module cannot read matches nothing, negated or not, as an unknown query does in a browser.
    if (answer === null) return false;
    result &&= answer;
  }
  return negate ? !result : result;
}

/** True when a media query list (as kept by the stylesheet filter) matches the environment. */
export function mediaQueryMatches(query: string, environment: MediaEnvironment): boolean {
  return query.split(",").some((single) => singleQueryMatches(single, environment));
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Rewrites a filtered stylesheet for one environment: matching `@media`
 * blocks are replaced by their rules, the others are removed. The result
 * contains no at-rules.
 */
export function resolveMediaQueries(css: string, environment: MediaEnvironment): string {
  let out = "";
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf("{", at);
    if (open < 0) break;
    const close = matchingBrace(css, open);
    if (close < 0) break;
    const prelude = css.slice(at, open);
    if (prelude.startsWith("@media ")) {
      if (mediaQueryMatches(prelude.slice(7), environment)) out += resolveMediaQueries(css.slice(open + 1, close), environment);
    } else if (!prelude.startsWith("@")) out += css.slice(at, close + 1);
    at = close + 1;
  }
  return out;
}
