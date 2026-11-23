/**
 * Turns untrusted mail HTML into markup that is safe to show.
 *
 * The mail is parsed into an inert document and a new tree is built from it,
 * keeping only allowlisted elements and attributes (see `policy.ts`). The
 * result is then parsed once more and checked node by node: what comes out is
 * markup that a browser reads back as exactly the tree that was checked.
 *
 * `MessageBody` adds two more layers on top: a sandboxed frame that cannot run
 * scripts, and a content security policy that blocks loads. This module must
 * still be safe on its own, because quoted replies go into the composer.
 */
import { filterDeclarations, filterStylesheet } from "./css-filter";
import { BODY_CLASS, RESERVED_CLASS_PREFIX } from "./css-selectors";
import { cleanLabel, createInertDocument, ELEMENT_NODE, isHtmlElement, parseBodyContent, parseDocument, plainTextBlock, TEXT_NODE, textOutside } from "./dom";
import { blockedImagePlaceholder, isTrackingPixel, missingImagePlaceholder } from "./images";
import { ALLOWED_ELEMENTS, DROPPED_ELEMENTS, filterAttribute, isColorAttribute, VOID_ELEMENTS } from "./policy";
import { findQuote, type QuoteMatch } from "./quotes";
import {
  classifyImageSource, DEFAULT_MAX_INLINE_IMAGE_BYTES, MAX_CONTENT_IDS, MAX_TOTAL_INLINE_IMAGE_BYTES,
  safeDataImageUrl, safeLinkUrl, safeRemoteImageUrl,
} from "./url-policy";
import { isSafeOutput } from "./verify";

export type RemoteImagePolicy = "block" | "allow" | "remove";

export interface SanitizeEmailOptions {
  /**
   * `block` (default): remote images become placeholders. `allow`: they load.
   * `remove`: every image, remote or inline, is replaced by its description.
   */
  remoteImages?: RemoteImagePolicy;
  /** Returns a `data:image/...;base64,` URL for a Content-ID, or null. See `createCidResolver`. */
  resolveCid?: (contentId: string) => string | null | undefined;
  /**
   * Called for each remote image when they are allowed. Return the address to
   * load instead (an http(s) or data image URL, for example from an image
   * proxy), or null to keep that image blocked.
   */
  resolveRemoteImage?: (url: string) => string | null | undefined;
  /** `collapse` (default) leaves the quoted trail of a reply out; `show` keeps it. */
  quotes?: "collapse" | "show";
  /** Keep the safe part of `<style>` elements in `css`. Default true. */
  stylesheets?: boolean;
  /** Keep `class` attributes. Default true. Turn off for markup placed in the app's own document. */
  classes?: boolean;
  /** Apply the stricter style rules for markup placed in the app's own document. Default false. */
  strictStyles?: boolean;
  /** Largest inline (data or cid) image, in decoded bytes. */
  maxInlineImageBytes?: number;
}

export interface SanitizedEmail {
  /** Safe body markup. Contains no `<style>`; pair it with `css` inside the message frame. */
  html: string;
  /** Safe rules from the mail's stylesheets. Only meaningful inside the message frame. */
  css: string;
  /** A quoted trail was found (and is either left out or shown, see `quoteCollapsed`). */
  hasQuote: boolean;
  quoteCollapsed: boolean;
  /** Remote images replaced by placeholders. */
  blockedImages: number;
  /** Tracking pixels removed. They are removed even when images are allowed. */
  trackersRemoved: number;
  /** Content-IDs the mail refers to, in order, without duplicates. */
  cidRefs: string[];
  /** The subset of `cidRefs` that could not be shown. */
  missingCids: string[];
  /** The mail sets text or background colours of its own. */
  hasOwnColors: boolean;
  /** The mail was too large and was cut. */
  truncated: boolean;
  /** The HTML could not be made safe and is shown as plain text instead. */
  fallback: boolean;
}

export const MAX_HTML_CHARS = 3_000_000;
export const MAX_NODES = 40_000;
const MAX_DEPTH = 100;
const MAX_CLASSES = 20;
const MAX_CSS_CHARS = 100_000;
const MAX_TITLE_CHARS = 300;

export function emptySanitizedEmail(): SanitizedEmail {
  return {
    html: "", css: "", hasQuote: false, quoteCollapsed: false, blockedImages: 0, trackersRemoved: 0,
    cidRefs: [], missingCids: [], hasOwnColors: false, truncated: false, fallback: false,
  };
}

interface Context {
  out: Document;
  result: SanitizedEmail;
  remoteImages: RemoteImagePolicy;
  options: SanitizeEmailOptions;
  maxInlineImageBytes: number;
  classes: boolean;
  strict: boolean;
  nodes: number;
  /** Characters of inline image data written so far. */
  inlineChars: number;
  /** The quote to leave out, when collapsing. */
  quote: QuoteMatch | null;
  /** Set once the walk must stop: the node budget ran out or a trailing quote began. */
  stopped: boolean;
}

function warn(message: string, error: unknown): void {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : typeof error;
  console.warn(`[mail-html] ${message}: ${name}`);
}

/** Text of a subtree without the content of dropped elements. */
function visibleText(root: Node): string {
  return textOutside(root, DROPPED_ELEMENTS);
}

function filterClasses(value: string): string {
  return value
    .split(/\s+/)
    .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name) && !name.toLowerCase().startsWith(RESERVED_CLASS_PREFIX))
    .slice(0, MAX_CLASSES)
    .join(" ");
}

function copyAttributes(source: Element, target: Element, tag: string, context: Context): void {
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name === "style") {
      const filtered = filterDeclarations(attribute.value, { strict: context.strict });
      if (filtered.css) target.setAttribute("style", filtered.css);
      context.result.hasOwnColors ||= filtered.hasColor;
    } else if (name === "class") {
      const classes = context.classes ? filterClasses(attribute.value) : "";
      if (classes) target.setAttribute("class", classes);
    } else {
      const value = filterAttribute(tag, name, attribute.value);
      if (value === null) continue;
      target.setAttribute(name, value);
      if (isColorAttribute(name)) context.result.hasOwnColors = true;
    }
  }
}

function resolveSafely<T>(what: string, resolve: () => T): T | null {
  try {
    return resolve();
  } catch (error) {
    // A resolver is caller code; a failure there means "no image", never a broken message.
    warn(`${what} resolver failed`, error);
    return null;
  }
}

/** Records a Content-ID in a bounded list, without duplicates. */
function remember(list: string[], id: string): void {
  if (list.length < MAX_CONTENT_IDS && !list.includes(id)) list.push(id);
}

/** Adds an image. Returns false when the message's inline image budget is used up. */
function appendImage(source: Element, target: Element, context: Context, url: string, remote: boolean): boolean {
  if (!remote) {
    // The whole message may hold four images of the largest size. Four base64 characters carry three bytes.
    const budget = Math.min(MAX_TOTAL_INLINE_IMAGE_BYTES, 4 * context.maxInlineImageBytes);
    if (context.inlineChars + url.length > Math.ceil((budget * 4) / 3)) return false;
    context.inlineChars += url.length;
  }
  const image = context.out.createElement("img");
  copyAttributes(source, image, "img", context);
  image.setAttribute("src", url);
  if (remote) image.setAttribute("referrerpolicy", "no-referrer");
  image.setAttribute("decoding", "async");
  target.appendChild(image);
  return true;
}

function appendDescription(source: Element, target: Element, context: Context): void {
  const alt = cleanLabel(source.getAttribute("alt"), 200);
  if (alt) target.appendChild(context.out.createTextNode(`[${alt}]`));
}

function cleanImage(source: Element, target: Element, context: Context): void {
  const { result } = context;
  const kind = classifyImageSource(source.getAttribute("src"), context.maxInlineImageBytes);
  if (kind.kind === "remote" && isTrackingPixel(source)) {
    result.trackersRemoved += 1;
    return;
  }
  if (kind.kind === "cid") remember(result.cidRefs, kind.id);
  if (kind.kind === "invalid" && !kind.local) return;
  if (context.remoteImages === "remove") {
    appendDescription(source, target, context);
    return;
  }
  if (kind.kind === "invalid") {
    target.appendChild(missingImagePlaceholder(context.out, source));
  } else if (kind.kind === "data") {
    if (!appendImage(source, target, context, kind.url, false)) target.appendChild(missingImagePlaceholder(context.out, source));
  } else if (kind.kind === "cid") {
    const { resolveCid } = context.options;
    const resolved = resolveCid ? resolveSafely("cid", () => resolveCid(kind.id)) : null;
    const url = safeDataImageUrl(resolved, context.maxInlineImageBytes);
    if (!url || !appendImage(source, target, context, url, false)) {
      remember(result.missingCids, kind.id);
      target.appendChild(missingImagePlaceholder(context.out, source));
    }
  } else {
    const { resolveRemoteImage } = context.options;
    let url: string | null = context.remoteImages === "allow" ? kind.url : null;
    if (url && resolveRemoteImage) {
      const resolved = resolveSafely("remote image", () => resolveRemoteImage(kind.url));
      url = safeDataImageUrl(resolved, context.maxInlineImageBytes) ?? safeRemoteImageUrl(resolved);
    }
    if (!url || !appendImage(source, target, context, url, !url.startsWith("data:"))) {
      result.blockedImages += 1;
      target.appendChild(blockedImagePlaceholder(context.out, source));
    }
  }
}

function cleanChildren(source: Node, target: Element, context: Context, depth: number): void {
  for (let child = source.firstChild; child && !context.stopped; child = child.nextSibling) cleanNode(child, target, context, depth);
}

function cleanNode(node: Node, target: Element, context: Context, depth: number): void {
  if (context.quote && node === context.quote.start) {
    if (context.quote.kind === "trail") context.stopped = true;
    return;
  }
  context.nodes += 1;
  if (context.nodes > MAX_NODES) {
    context.result.truncated = true;
    context.stopped = true;
    return;
  }
  if (node.nodeType === TEXT_NODE) {
    target.appendChild(context.out.createTextNode((node as Text).data));
    return;
  }
  // Comments, processing instructions and anything outside the HTML namespace (svg, math) go entirely.
  if (node.nodeType !== ELEMENT_NODE || !isHtmlElement(node)) return;
  const tag = node.localName;
  if (DROPPED_ELEMENTS.has(tag)) return;
  if (depth >= MAX_DEPTH) {
    target.appendChild(context.out.createTextNode(visibleText(node)));
    return;
  }
  if (tag === "img") {
    cleanImage(node, target, context);
    return;
  }
  if (!ALLOWED_ELEMENTS.has(tag)) {
    // Unknown and structural elements (form, label, custom tags) are unwrapped: their content is kept, sanitised.
    cleanChildren(node, target, context, depth + 1);
    return;
  }
  const clean = context.out.createElement(tag);
  copyAttributes(node, clean, tag, context);
  if (tag === "a") {
    const href = safeLinkUrl(node.getAttribute("href"));
    if (href) {
      clean.setAttribute("href", href);
      clean.setAttribute("target", "_blank");
      clean.setAttribute("rel", "noopener noreferrer");
      // The tooltip always shows where the link really goes.
      clean.setAttribute("title", href.length > MAX_TITLE_CHARS ? `${href.slice(0, MAX_TITLE_CHARS)}…` : href);
    }
  }
  target.appendChild(clean);
  if (!VOID_ELEMENTS.has(tag)) cleanChildren(node, clean, context, depth + 1);
}

/** Removes the blank lines a collapsed quote leaves at the end. */
function trimTrailingBlank(container: Element): void {
  for (let last = container.lastChild; last; last = container.lastChild) {
    if (last.nodeType === TEXT_NODE) {
      if ((last as Text).data.replace(/[\s\u00A0]/g, "") !== "") return;
    } else if (isHtmlElement(last) && last.localName !== "br") {
      if (!/^(?:div|p|span|font|b|i|u|em|strong|center|section|article)$/.test(last.localName)) return;
      trimTrailingBlank(last);
      if (last.firstChild) return;
    }
    container.removeChild(last);
  }
}

function collectStylesheets(source: Document, result: SanitizedEmail): void {
  for (const style of Array.from(source.querySelectorAll("style"))) {
    if (!isHtmlElement(style) || result.css.length >= MAX_CSS_CHARS) continue;
    const media = (style.getAttribute("media") ?? "").trim().toLowerCase();
    if (media && media !== "all" && media !== "screen") continue;
    const filtered = filterStylesheet(style.textContent ?? "");
    if (result.css.length + filtered.css.length > MAX_CSS_CHARS) continue;
    result.css += filtered.css;
    result.hasOwnColors ||= filtered.hasColor;
  }
}

/** Builds the element that stands in for the mail's `<body>` and carries its colours and direction. */
function bodyWrapper(body: Element, context: Context): HTMLElement {
  const wrapper = context.out.createElement("div");
  copyAttributes(body, wrapper, "div", context);
  const text = /^#?[A-Za-z0-9]{1,24}$/.exec((body.getAttribute("text") ?? "").trim());
  if (text) {
    const declared = filterDeclarations(`color:${text[0]}${wrapper.hasAttribute("style") ? `;${wrapper.getAttribute("style")}` : ""}`, { strict: context.strict });
    if (declared.css) wrapper.setAttribute("style", declared.css);
    context.result.hasOwnColors ||= declared.hasColor;
  }
  if (context.classes) {
    const own = wrapper.getAttribute("class");
    wrapper.setAttribute("class", own ? `${BODY_CLASS} ${own}` : BODY_CLASS);
  }
  return wrapper;
}

/**
 * Parses the markup again, as a browser will, until it reads back unchanged,
 * and checks the tree it produces. Returns null when the markup does not
 * settle or the tree holds anything outside the output vocabulary.
 */
function settle(markup: string): string | null {
  let current = markup;
  for (let pass = 0; pass < 3; pass += 1) {
    const body = parseBodyContent(current);
    if (!isSafeOutput(body)) return null;
    const next = body.innerHTML;
    if (next === current) return current;
    current = next;
  }
  return null;
}

function plainFallback(source: Document, context: Context): string {
  const text = visibleText(source.body ?? source.documentElement).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return "";
  const container = context.out.createElement("div");
  container.appendChild(plainTextBlock(context.out, text));
  return container.innerHTML;
}

/**
 * Sanitises the HTML body of a mail. The returned `html` is safe to parse in
 * any document; with the default options it is meant for the message frame
 * (see `MessageBody`). Use `sanitizeForQuote` for markup that goes into the
 * app's own document.
 */
export function sanitizeEmailHtml(html: string, options: SanitizeEmailOptions = {}): SanitizedEmail {
  const result = emptySanitizedEmail();
  if (typeof html !== "string" || html.trim() === "") return result;
  result.truncated = html.length > MAX_HTML_CHARS;
  const source = parseDocument(result.truncated ? html.slice(0, MAX_HTML_CHARS) : html);
  const body = source.body && source.body.localName === "body" ? source.body : null;
  const context: Context = {
    out: createInertDocument(),
    result,
    remoteImages: options.remoteImages ?? "block",
    options,
    maxInlineImageBytes: options.maxInlineImageBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES,
    classes: options.classes ?? true,
    strict: options.strictStyles ?? false,
    nodes: 0,
    inlineChars: 0,
    quote: null,
    stopped: false,
  };
  if (!body) return result;
  if (options.stylesheets ?? true) collectStylesheets(source, result);

  const quote = findQuote(body);
  result.hasQuote = quote !== null;
  result.quoteCollapsed = quote !== null && (options.quotes ?? "collapse") === "collapse";
  if (result.quoteCollapsed) context.quote = quote;

  const wrapper = bodyWrapper(body, context);
  cleanChildren(body, wrapper, context, 0);
  if (result.quoteCollapsed) trimTrailingBlank(wrapper);

  const container = context.out.createElement("div");
  container.appendChild(wrapper);
  const markup = wrapper.attributes.length > 0 ? container.innerHTML : wrapper.innerHTML;
  const settled = settle(markup);
  if (settled !== null) {
    result.html = settled;
    return result;
  }
  // The markup would not hold still under re-parsing: show the words only.
  return { ...emptySanitizedEmail(), truncated: result.truncated, fallback: true, html: plainFallback(source, context) };
}

/**
 * Sanitises mail HTML for quoting in a reply. The result is meant for the
 * app's own document (the composer): no classes, no stylesheet, no images
 * (their descriptions are kept), no styles that could move content over the
 * surrounding UI, and the earlier quotes are kept.
 */
export function sanitizeForQuote(html: string): string {
  return sanitizeEmailHtml(html, { remoteImages: "remove", quotes: "show", stylesheets: false, classes: false, strictStyles: true }).html;
}
