/**
 * The element and attribute allowlists for mail content.
 *
 * Three kinds of element exist: allowed (rebuilt with filtered attributes),
 * dropped (removed with everything inside) and everything else, which is
 * unwrapped: the element goes, its children are sanitised in its place.
 * `id` and `name` are never kept, so mail cannot shadow document properties.
 */
import { cleanLabel } from "./dom";

/** Removed together with their content. */
export const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  "script", "style", "template", "noscript", "noembed", "noframes", "plaintext", "xmp", "listing", "title", "head",
  "iframe", "frame", "frameset", "object", "embed", "applet", "param", "portal", "fencedframe",
  "svg", "math", "canvas", "audio", "video", "source", "track",
  "input", "button", "select", "option", "optgroup", "textarea", "datalist", "output", "keygen", "meter", "progress", "isindex",
  "meta", "base", "link", "basefont", "bgsound", "map", "area", "dialog", "slot", "menuitem",
]);

/** Rebuilt in the output. `img` is handled on its own path and is not listed here. */
export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q",
  "rp", "rt", "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var", "wbr",
]);

export const VOID_ELEMENTS: ReadonlySet<string> = new Set(["br", "hr", "col", "wbr", "img"]);

type Rule = (value: string) => string | null;

const pattern = (expression: RegExp): Rule => (value) => {
  const trimmed = value.trim();
  return expression.test(trimmed) ? trimmed : null;
};
const oneOf = (...names: string[]): Rule => (value) => {
  const lower = value.trim().toLowerCase();
  return names.includes(lower) ? lower : null;
};
const flag: Rule = () => "";
const label: Rule = (value) => cleanLabel(value) || null;

const dimension = pattern(/^\d{1,5}(?:\.\d{1,3})?(?:%|px)?$/);
const smallNumber = pattern(/^\d{1,4}$/);
const spanCount = pattern(/^\d{1,3}$/);
const color = pattern(/^#?[A-Za-z0-9]{1,24}$/);

const GLOBAL_RULES: Readonly<Record<string, Rule>> = {
  dir: oneOf("ltr", "rtl", "auto"),
  lang: pattern(/^[A-Za-z0-9-]{1,35}$/),
  title: label,
  align: oneOf("left", "right", "center", "justify", "middle", "top", "bottom", "baseline", "absmiddle", "char"),
  valign: oneOf("top", "middle", "bottom", "baseline"),
  width: dimension,
  height: dimension,
  bgcolor: color,
  role: oneOf("presentation", "none"),
  "aria-hidden": oneOf("true", "false"),
  "aria-label": label,
};

const listType = pattern(/^(?:[1aAiI]|disc|circle|square)$/);
const ELEMENT_RULES: Readonly<Record<string, Readonly<Record<string, Rule>>>> = {
  // A link's tooltip is replaced by its real destination, so the sender's `title` is never kept.
  a: { title: () => null },
  table: { border: smallNumber, cellpadding: smallNumber, cellspacing: smallNumber },
  td: { colspan: spanCount, rowspan: spanCount, nowrap: flag, scope: oneOf("row", "col", "rowgroup", "colgroup") },
  th: { colspan: spanCount, rowspan: spanCount, nowrap: flag, scope: oneOf("row", "col", "rowgroup", "colgroup") },
  col: { span: spanCount },
  colgroup: { span: spanCount },
  font: { color, face: pattern(/^[\p{L}\p{N} _.,'"-]{1,200}$/u), size: pattern(/^[+-]?\d$/) },
  ol: { start: pattern(/^-?\d{1,6}$/), type: listType, reversed: flag },
  ul: { type: listType },
  li: { value: pattern(/^-?\d{1,6}$/), type: listType },
  img: { alt: (value) => cleanLabel(value), border: smallNumber, hspace: smallNumber, vspace: smallNumber },
  hr: { size: smallNumber, noshade: flag, color },
  br: { clear: oneOf("left", "right", "all", "none") },
};

/** Attributes the sanitiser writes itself. */
const GENERATED_ATTRIBUTES = ["class", "style", "href", "target", "rel", "src", "referrerpolicy", "decoding"];

/** Every attribute name that can appear in sanitised output. */
export const OUTPUT_ATTRIBUTES: ReadonlySet<string> = new Set([
  ...GENERATED_ATTRIBUTES,
  ...Object.keys(GLOBAL_RULES),
  ...Object.values(ELEMENT_RULES).flatMap((rules) => Object.keys(rules)),
]);

/**
 * The value to keep for an attribute, or null to drop it. `style`, `class`,
 * `href` and `src` are not handled here: each has its own filter.
 */
export function filterAttribute(tag: string, name: string, value: string): string | null {
  const own = Object.prototype.hasOwnProperty;
  const elementRules = own.call(ELEMENT_RULES, tag) ? ELEMENT_RULES[tag] : undefined;
  const rule = elementRules && own.call(elementRules, name) ? elementRules[name] : own.call(GLOBAL_RULES, name) ? GLOBAL_RULES[name] : undefined;
  return rule ? rule(value) : null;
}

/** True for an attribute that gives an element its own colours. */
export function isColorAttribute(name: string): boolean {
  return name === "bgcolor" || name === "color";
}
