/**
 * Escaping for the exports. Every string that comes from a document (text,
 * authors, style names, ids, link targets) passes through one of these
 * before it reaches the output; tag and attribute names are always fixed.
 */

import type { Hyperlink } from "../../api/docx-model.js";

const HTML_SPECIAL = /[&<>"'\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function htmlReplacement(char: string): string {
  switch (char) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&#39;";
    default:
      return "";
  }
}

/** Escapes text for element content or a quoted attribute value. Control characters are dropped. */
export function escapeHtml(value: string): string {
  return value.replace(HTML_SPECIAL, htmlReplacement);
}

/**
 * A string safe inside an `id` attribute and a URL fragment: ASCII letters
 * and digits stay, every other UTF-16 unit becomes `_` and four hex digits.
 * Distinct inputs give distinct tokens.
 */
export function safeToken(value: string): string {
  let out = "";
  for (let index = 0; index < value.length && index < 256; index++) {
    const char = value[index] as string;
    out += /[A-Za-z0-9-]/.test(char) ? char : `_${value.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return out;
}

const SAFE_SCHEME = /^(?:https?:|mailto:)/i;
const URL_FORBIDDEN = /[\u0000- \u007F"'<>\\`]/;

/** An external link target the exports may emit: `http`, `https` or `mailto`, without spaces or quotes. */
export function safeExternalHref(href: string | null): string | null {
  if (href === null || href.length > 2048) return null;
  const trimmed = href.trim();
  if (!SAFE_SCHEME.test(trimmed) || URL_FORBIDDEN.test(trimmed)) return null;
  return trimmed;
}

/** Fragment id of a bookmark in the HTML export. */
export const bookmarkAnchor = (name: string): string => `bm-${safeToken(name)}`;

/** The `href` of a hyperlink in the HTML export, or null when it must not be a link. */
export function hyperlinkHref(link: Hyperlink | null): string | null {
  if (link === null) return null;
  const external = safeExternalHref(link.href);
  if (external !== null) return external;
  if (link.href === null && link.anchor !== null && link.anchor !== "") return `#${bookmarkAnchor(link.anchor)}`;
  return null;
}

/** True for a `#rrggbb` colour, the only form the exports put into a style attribute. */
export const isHexColor = (value: string | null): value is string => value !== null && /^#[0-9a-f]{6}$/i.test(value);

const MONOSPACE = new Set(["consolas", "courier", "courier new", "menlo", "monaco", "lucida console", "source code pro"]);

/** True for a font family that is shown as code. */
export const isMonospace = (family: string | null): boolean => family !== null && MONOSPACE.has(family.toLowerCase());
