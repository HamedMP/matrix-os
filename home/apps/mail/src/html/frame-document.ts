/**
 * Builds the document a message is shown in. The frame is the second and
 * third line of defence behind the sanitiser: its sandbox runs no script and
 * has no origin, and its content security policy loads nothing but images the
 * owner has agreed to.
 */
import { parseBodyContent } from "./dom";
import { isSafeOutput } from "./verify";

/**
 * Sandbox tokens for the message frame. No `allow-scripts`, no
 * `allow-same-origin`, no forms, no top navigation: mail can only be read,
 * and its links can only open somewhere else.
 */
export const FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/** Class of the element that wraps the mail, in the frame and in the measuring copy. */
export const ROOT_CLASS = "mx-root";

export interface FrameTheme {
  scheme: "light" | "dark";
  foreground: string;
  background: string;
  muted: string;
  border: string;
  link: string;
  fontFamily: string;
  /** Space around the mail inside the frame, in pixels (0 to 48). */
  padding: number;
}

/** Readable light colours. */
export const DEFAULT_FRAME_THEME: FrameTheme = Object.freeze({
  scheme: "light",
  foreground: "#1f2328",
  background: "#ffffff",
  muted: "#667085",
  border: "#d0d7de",
  link: "#1a5fd0",
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  padding: 0,
});

/** The light page a mail with its own colours is shown on when the app theme is dark. */
export const PAPER_FRAME_THEME: FrameTheme = Object.freeze({ ...DEFAULT_FRAME_THEME, padding: 12 });

export interface FrameDocumentInput {
  /** Markup from `sanitizeEmailHtml`, `textToHtml` or `renderMailBody`. It is checked again here. */
  html: string;
  /** The `css` that came with it. */
  css: string;
  theme: FrameTheme;
  /** True once the owner chose to load remote images for this message. */
  allowRemoteImages: boolean;
}

const COLOR_VALUE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|color|oklch|oklab|lab|lch)\([0-9a-zA-Z\s.,%/+-]{1,80}\))$/;
const FONT_VALUE = /^[\p{L}\p{N} _.,'"-]{1,300}$/u;

function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && COLOR_VALUE.test(value.trim()) ? value.trim() : fallback;
}

/** Theme values end up inside a style element, so each is checked against a strict shape first. */
export function safeFrameTheme(theme: FrameTheme): FrameTheme {
  const base = DEFAULT_FRAME_THEME;
  return {
    scheme: theme.scheme === "dark" ? "dark" : "light",
    foreground: safeColor(theme.foreground, base.foreground),
    background: safeColor(theme.background, base.background),
    muted: safeColor(theme.muted, base.muted),
    border: safeColor(theme.border, base.border),
    link: safeColor(theme.link, base.link),
    fontFamily: typeof theme.fontFamily === "string" && FONT_VALUE.test(theme.fontFamily.trim()) ? theme.fontFamily.trim() : base.fontFamily,
    padding: Number.isFinite(theme.padding) ? Math.min(48, Math.max(0, Math.round(theme.padding))) : 0,
  };
}

/**
 * The frame's policy. Everything is off by default: no script, no frame, no
 * font, no media, no connection. Inline styles are allowed because sanitised
 * mail keeps its filtered `style` attributes. Images are limited to inline
 * data until the owner loads remote images.
 */
export function frameContentSecurityPolicy(allowRemoteImages: boolean): string {
  return [
    "default-src 'none'",
    `img-src data:${allowRemoteImages ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Default look of mail content, shared by the frame and the measuring copy.
 * Element defaults sit in `:where()` so they have no specificity and the
 * mail's own rules always win over them.
 */
export function contentCss(input: FrameTheme): string {
  const theme = safeFrameTheme(input);
  const root = `.${ROOT_CLASS}`;
  const base = `:where(${root})`;
  return [
    `${root}{display:flow-root;box-sizing:border-box;margin:0;padding:${theme.padding}px;color:${theme.foreground};background:${theme.background};font-family:${theme.fontFamily};font-size:14px;line-height:1.5;overflow-wrap:anywhere;overflow-x:auto;color-scheme:${theme.scheme}}`,
    `${base} a{color:${theme.link}}`,
    `${base} img{max-width:100%}`,
    `${base} blockquote{margin:0 0 0 .8em;padding:0 0 0 .8em;border-left:2px solid ${theme.border}}`,
    `${base} pre{white-space:pre-wrap}`,
    `${base} hr{border:0;border-top:1px solid ${theme.border}}`,
    `${base} table{font-size:inherit}`,
    `${root} .mx-plain{white-space:pre-wrap}`,
    `${root} .mx-image-blocked,${root} .mx-image-missing{display:inline-block;box-sizing:border-box;max-width:100%;min-width:24px;min-height:24px;padding:4px 8px;border:1px dashed ${theme.border};border-radius:4px;color:${theme.muted};font-size:12px;line-height:1.3;overflow:hidden;vertical-align:middle}`,
  ].join("");
}

function frameCss(theme: FrameTheme): string {
  return `html{color-scheme:${theme.scheme}}html,body{margin:0;padding:0;background:${theme.background}}`;
}

/**
 * The `srcdoc` for the message frame. The policy comes first in the head, so
 * it is in force before any mail markup is parsed.
 */
export function buildFrameDocument(input: FrameDocumentInput): string {
  const theme = safeFrameTheme(input.theme);
  // The sanitiser never writes `<` into a sheet; one here would close the style element.
  const css = typeof input.css === "string" && !input.css.includes("<") ? input.css : "";
  // Last gate at the point of use: only markup the sanitiser could have written goes into the frame.
  const html = typeof input.html === "string" && isSafeOutput(parseBodyContent(input.html)) ? input.html : "";
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${frameContentSecurityPolicy(input.allowRemoteImages === true)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<meta name="color-scheme" content="${theme.scheme}">`,
    '<base target="_blank">',
    `<style>${frameCss(theme)}${contentCss(theme)}</style>`,
    css ? `<style>${css}</style>` : "",
    `</head><body><div class="${ROOT_CLASS}">${html}</div></body></html>`,
  ].join("");
}
