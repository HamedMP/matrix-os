/**
 * Turns clipboard content into paragraphs of text with basic formatting
 * (bold, italic, underline). Nothing else of the source survives: no styles,
 * no links, no images, no markup. HTML is parsed in an inert document and
 * only its text nodes are read.
 */

export interface PasteSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface PasteContent {
  /** One list of segments per paragraph; never empty. */
  paragraphs: PasteSegment[][];
  /** True when some text is bold, italic or underlined, so every segment must set its format explicitly. */
  formatted: boolean;
}

/** The part of `DataTransfer` this module reads. */
export interface ClipboardSource {
  getData(type: string): string;
}

export const MAX_PASTE_CHARACTERS = 1_000_000;
const MAX_PASTE_HTML = 4_000_000;

const BLOCK_TAGS: ReadonlySet<string> = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "BLOCKQUOTE", "PRE", "UL", "OL", "TABLE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "DD", "DT"]);
const SKIPPED_TAGS: ReadonlySet<string> = new Set(["SCRIPT", "STYLE", "HEAD", "META", "TITLE", "LINK", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "SVG", "MATH"]);

/**
 * Text the engine accepts: line breaks as `\n`, tabs kept, every other control
 * character and the object placeholder U+FFFC removed.
 */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F￼]/g, "");
}

export function parsePlainText(text: string): PasteContent {
  const lines = cleanText(text.slice(0, MAX_PASTE_CHARACTERS)).split("\n");
  return {
    paragraphs: lines.map((line) => (line === "" ? [] : [{ text: line, bold: false, italic: false, underline: false }])),
    formatted: false,
  };
}

interface Format {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function formatOf(element: Element, inherited: Format): Format {
  const format = { ...inherited };
  const tag = element.tagName;
  if (tag === "B" || tag === "STRONG") format.bold = true;
  if (tag === "I" || tag === "EM") format.italic = true;
  if (tag === "U") format.underline = true;
  const style = (element as HTMLElement).style;
  if (style === undefined) return format;
  const weight = style.fontWeight;
  if (weight !== "") format.bold = weight === "bold" || weight === "bolder" || Number(weight) >= 600;
  if (style.fontStyle !== "") format.italic = style.fontStyle === "italic" || style.fontStyle === "oblique";
  const decoration = `${style.textDecorationLine} ${style.textDecoration}`;
  if (decoration.includes("underline")) format.underline = true;
  return format;
}

function hidden(element: Element): boolean {
  const style = (element as HTMLElement).style;
  return style !== undefined && (style.display === "none" || style.visibility === "hidden");
}

export function parseHtml(html: string): PasteContent | null {
  if (typeof DOMParser === "undefined" || html.length > MAX_PASTE_HTML) return null;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const paragraphs: PasteSegment[][] = [[]];
  let formatted = false;
  let budget = MAX_PASTE_CHARACTERS;
  let breakPending = false;
  const current = (): PasteSegment[] => paragraphs[paragraphs.length - 1] as PasteSegment[];
  const startParagraph = (): void => {
    if (current().length > 0) paragraphs.push([]);
    breakPending = false;
  };
  const addText = (raw: string, format: Format, preformatted: boolean): void => {
    let text = cleanText(raw);
    if (!preformatted) text = text.replace(/[ \t\n]+/g, " ");
    if (breakPending && text.trim() !== "") startParagraph();
    const line = current();
    if (line.length === 0 && !preformatted) text = text.replace(/^ +/, "");
    if (text === "" || budget <= 0) return;
    text = text.slice(0, budget);
    budget -= text.length;
    const last = line[line.length - 1];
    if (last !== undefined && last.bold === format.bold && last.italic === format.italic && last.underline === format.underline) last.text += text;
    else line.push({ text, ...format });
    if (format.bold || format.italic || format.underline) formatted = true;
  };
  const walk = (node: Node, format: Format, preformatted: boolean): void => {
    if (node.nodeType === 3) {
      addText(node.nodeValue ?? "", format, preformatted);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag) || hidden(element)) return;
    if (tag === "BR") {
      addText("\n", format, true);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) breakPending = current().length > 0 || breakPending;
    if ((tag === "TD" || tag === "TH") && element.previousElementSibling !== null) addText("\t", format, true);
    const inner = formatOf(element, format);
    for (const child of Array.from(element.childNodes)) walk(child, inner, preformatted || tag === "PRE");
    if (block) breakPending = current().length > 0 || breakPending;
  };
  walk(parsed.body, { bold: false, italic: false, underline: false }, false);
  for (const line of paragraphs) {
    const last = line[line.length - 1];
    if (last !== undefined) last.text = last.text.replace(/ +$/, "");
    if (last !== undefined && last.text === "") line.pop();
  }
  if (paragraphs.every((line) => line.length === 0)) return null;
  return { paragraphs, formatted };
}

/**
 * What a paste should insert. Formatted HTML wins when it carries bold,
 * italic or underline; otherwise the plain text is used, which keeps line
 * structure best. Null when the clipboard has no text.
 */
export function readClipboard(source: ClipboardSource | null | undefined): PasteContent | null {
  if (source === null || source === undefined) return null;
  let html = "";
  let plain = "";
  try {
    html = source.getData("text/html");
    plain = source.getData("text/plain");
  } catch (error) {
    // A clipboard that cannot be read is an empty clipboard.
    console.warn("docs: the clipboard could not be read", error);
    return null;
  }
  if (html !== "") {
    const rich = parseHtml(html);
    if (rich !== null && (rich.formatted || plain === "")) return rich;
  }
  return plain === "" ? null : parsePlainText(plain);
}
