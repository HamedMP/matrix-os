/** Small DOM helpers shared by the mail HTML modules. Documents made here are inert: they run no script and load nothing. */

export const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/** Class of the block that holds a plain-text body. */
export const PLAIN_CLASS = "mx-plain";

/** Parses a whole HTML document the way a browser would, without running or loading anything. */
export function parseDocument(markup: string): Document {
  return new DOMParser().parseFromString(markup, "text/html");
}

/** Parses markup as the content of a `<body>`, which is where sanitised mail is always placed. */
export function parseBodyContent(markup: string): HTMLElement {
  return parseDocument(`<!doctype html><html><head></head><body>${markup}</body></html>`).body;
}

/** An empty document to build clean nodes in. */
export function createInertDocument(): Document {
  return parseDocument("<!doctype html><html><head></head><body></body></html>");
}

export function isHtmlElement(node: Node): node is HTMLElement {
  return node.nodeType === ELEMENT_NODE && (node as Element).namespaceURI === XHTML_NAMESPACE;
}

/**
 * The text under `root`, leaving out the content of the named elements.
 * Iterative, so a deeply nested mail cannot overflow the stack.
 */
export function textOutside(root: Node, skipped: ReadonlySet<string>): string {
  let text = "";
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType === TEXT_NODE) text += (node as Text).data;
    else if (isHtmlElement(node) && !skipped.has(node.localName)) {
      for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
    }
  }
  return text;
}

const INVISIBLE = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Removes characters that take no space: soft hyphens, zero-width marks and direction overrides. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** True when text has nothing a reader would see. */
export function isBlank(text: string): boolean {
  return stripInvisible(text).replace(/[\s\u00A0]/g, "") === "";
}

/**
 * Attribute text shown to the reader: bounded, without control characters and
 * without angle brackets, so no attribute value can look like markup to any
 * parser the output later passes through.
 */
export function cleanLabel(value: string | null, max = 1000): string {
  if (!value) return "";
  return stripInvisible(value).replace(/[\u0000-\u001F\u007F<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Builds a plain-text block: each line as text, separated by `<br>`. Used when HTML cannot be shown safely. */
export function plainTextBlock(doc: Document, text: string): HTMLElement {
  const block = doc.createElement("div");
  block.setAttribute("class", PLAIN_CLASS);
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((line, index) => {
    if (index > 0) block.appendChild(doc.createElement("br"));
    if (line) block.appendChild(doc.createTextNode(line));
  });
  return block;
}
