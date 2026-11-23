/**
 * The second check on sanitised markup. The sanitiser builds a tree; this
 * module looks at the tree a browser gets when it parses the serialised
 * result, and accepts it only if every node and attribute is one the
 * sanitiser is able to write. It shares the allowlists but none of the
 * sanitiser's walking code.
 */
import { filterDeclarations } from "./css-filter";
import { ELEMENT_NODE, isHtmlElement, TEXT_NODE } from "./dom";
import { ALLOWED_ELEMENTS, OUTPUT_ATTRIBUTES } from "./policy";
import { safeDataImageUrl, safeLinkUrl, safeRemoteImageUrl } from "./url-policy";

const NO_SIZE_CAP = 64 * 1024 * 1024;

function isSafeAttribute(tag: string, name: string, value: string): boolean {
  // No sanitised value contains an angle bracket; one here means the markup was read differently than it was written.
  if (name.startsWith("on") || !OUTPUT_ATTRIBUTES.has(name) || /[<>]/.test(value)) return false;
  switch (name) {
    case "href":
      return tag === "a" && safeLinkUrl(value) === value;
    case "src":
      return tag === "img" && (safeDataImageUrl(value, NO_SIZE_CAP) === value || safeRemoteImageUrl(value) === value);
    case "style":
      return filterDeclarations(value).css === value;
    case "target":
      return value === "_blank";
    case "rel":
      return value === "noopener noreferrer";
    default:
      return true;
  }
}

/** True when every node under `root` is text or an allowlisted HTML element with allowlisted, re-validated attributes. */
export function isSafeOutput(root: Element): boolean {
  const stack: Node[] = Array.from(root.childNodes);
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType === TEXT_NODE) continue;
    if (node.nodeType !== ELEMENT_NODE || !isHtmlElement(node)) return false;
    const tag = node.localName;
    if (tag !== "img" && !ALLOWED_ELEMENTS.has(tag)) return false;
    for (const attribute of Array.from(node.attributes)) {
      if (!isSafeAttribute(tag, attribute.name, attribute.value)) return false;
    }
    if (tag === "a" && node.hasAttribute("href") && (node.getAttribute("target") !== "_blank" || node.getAttribute("rel") !== "noopener noreferrer")) return false;
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
  }
  return true;
}
