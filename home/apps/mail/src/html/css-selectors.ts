/**
 * Selector allowlist for mail stylesheets. A selector is read token by token;
 * one token that is not on the list drops the whole rule. `html` and `body`
 * are retargeted at the wrapper the sanitiser puts around the mail.
 */

/** Class given to the element that stands in for the mail's `<body>`. */
export const BODY_CLASS = "mx-body";
/** Class names with this prefix belong to the sanitiser; mail cannot use or style them. */
export const RESERVED_CLASS_PREFIX = "mx-";

const MAX_SELECTOR_CHARS = 500;

const ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  "align", "valign", "width", "height", "class", "dir", "lang", "role", "bgcolor", "border",
  "cellpadding", "cellspacing", "colspan", "rowspan", "type", "size", "color", "face",
]);

const ATTRIBUTE_VALUE = `(?:"[A-Za-z0-9 _%#.-]*"|'[A-Za-z0-9 _%#.-]*'|[A-Za-z0-9_%#.-]+)`;
const TOKEN = new RegExp(
  [
    "(?<gap>[\\s>+~,]+)",
    "(?<type>\\*|[A-Za-z][A-Za-z0-9-]*)",
    "(?<simple>[.#]-?[A-Za-z_][A-Za-z0-9_-]*)",
    `(?<attribute>\\[\\s*(?<name>[A-Za-z][A-Za-z-]*)\\s*(?:[~|^$*]?=\\s*${ATTRIBUTE_VALUE}\\s*)?\\])`,
    "(?<pseudo>:(?:hover|link|visited|active|focus|first-child|last-child|only-child|first-of-type|last-of-type|empty)(?![A-Za-z0-9_(-]))",
    "(?<nth>:(?:nth-child|nth-last-child|nth-of-type)\\(\\s*(?:odd|even|[0-9n+\\- ]{1,12})\\s*\\))",
    "(?<not>:not\\(\\s*[A-Za-z0-9.#_-]{1,60}\\s*\\))",
  ].join("|"),
  "y",
);

/** Returns the selector in normalised form, or null when any part of it is not allowed. */
export function filterSelector(selector: string): string | null {
  const text = selector.trim();
  if (!text || text.length > MAX_SELECTOR_CHARS || text.toLowerCase().includes(`.${RESERVED_CLASS_PREFIX}`)) return null;
  let out = "";
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (!match?.groups) return null;
    const { gap, type, name } = match.groups;
    if (gap !== undefined) out += gap.replace(/\s+/g, " ");
    else if (type !== undefined) out += /^(?:html|body)$/i.test(type) ? `.${BODY_CLASS}` : type;
    else if (name !== undefined && !ATTRIBUTE_NAMES.has(name.toLowerCase())) return null;
    else out += match[0];
  }
  return out.trim() || null;
}
