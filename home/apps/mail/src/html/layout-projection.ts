/**
 * A layout-only copy of sanitised mail, used to learn how tall the message
 * frame must be.
 *
 * The frame has no scripts and a different origin, so the app cannot ask it
 * for its height. Instead the app lays out a copy of the same content in a
 * hidden, inert shadow tree and measures that.
 *
 * The copy lives in the app's own document, so it is built to a much smaller
 * allowlist than the mail itself: elements are created one by one, and only
 * attributes that affect layout are copied. It has no links, no handlers, no
 * text alternatives and no URL other than a checked image address.
 */
import { filterDeclarations } from "./css-filter";
import { isHtmlElement, parseBodyContent, TEXT_NODE } from "./dom";
import { ROOT_CLASS } from "./frame-document";
import { ALLOWED_ELEMENTS, filterAttribute, VOID_ELEMENTS } from "./policy";
import { safeDataImageUrl, safeRemoteImageUrl } from "./url-policy";

const LAYOUT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "width", "height", "align", "valign", "colspan", "rowspan", "span", "cellpadding", "cellspacing", "border",
  "dir", "size", "face", "start", "type", "nowrap", "hspace", "vspace",
]);
const MAX_DEPTH = 120;
const NO_SIZE_CAP = 64 * 1024 * 1024;

function copyLayoutAttributes(source: Element, target: Element, tag: string): void {
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name;
    if (name === "style") {
      const style = filterDeclarations(attribute.value).css;
      if (style) target.setAttribute("style", style);
    } else if (name === "class") {
      if (/^[A-Za-z0-9_ -]{1,2000}$/.test(attribute.value)) target.setAttribute("class", attribute.value);
    } else if (LAYOUT_ATTRIBUTES.has(name)) {
      const value = filterAttribute(tag, name, attribute.value);
      if (value !== null) target.setAttribute(name, value);
    }
  }
}

function copyChildren(source: Node, target: Element, doc: Document, depth: number): void {
  for (let child = source.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === TEXT_NODE) {
      target.appendChild(doc.createTextNode((child as Text).data));
      continue;
    }
    if (!isHtmlElement(child) || depth >= MAX_DEPTH) continue;
    const tag = child.localName;
    if (tag === "img") {
      const src = child.getAttribute("src");
      const url = safeDataImageUrl(src, NO_SIZE_CAP) ?? safeRemoteImageUrl(src);
      if (!url) continue;
      const image = doc.createElement("img");
      copyLayoutAttributes(child, image, tag);
      image.setAttribute("src", url);
      image.setAttribute("referrerpolicy", "no-referrer");
      target.appendChild(image);
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(tag)) continue;
    const copy = doc.createElement(tag);
    copyLayoutAttributes(child, copy, tag);
    target.appendChild(copy);
    if (!VOID_ELEMENTS.has(tag)) copyChildren(child, copy, doc, depth + 1);
  }
}

/**
 * Builds the measuring copy of `html` (sanitiser output) with nodes owned by
 * `doc`. Returns the root element; nothing is attached to the document.
 */
export function buildLayoutProjection(html: string, doc: Document): HTMLElement {
  const root = doc.createElement("div");
  root.setAttribute("class", ROOT_CLASS);
  if (typeof html === "string" && html !== "") copyChildren(parseBodyContent(html), root, doc, 0);
  return root;
}
