/**
 * Pasting into the composer. Clipboard HTML is untrusted: it goes through
 * the mail HTML sanitiser (`sanitizeForQuote`, meant for the app's own
 * document) and then through the redline engine's allowlist, so only plain
 * structure (paragraphs, lists, quotes, bold, italic, underline, safe links)
 * reaches the editor.
 */
import { sanitiseHtml } from "../../../_shared/office-engine/redline/index";
import { textToHtml } from "../../../_shared/office-accounts/mail/text";
import { sanitizeForQuote } from "../html";

/** Largest pasted HTML or text read, in characters; more is cut. */
export const MAX_PASTE_CHARS = 200_000;

function capped(text: string): string {
  return text.length > MAX_PASTE_CHARS ? text.slice(0, MAX_PASTE_CHARS) : text;
}

/** Safe editor markup from clipboard HTML. */
export function sanitizePastedHtml(html: string): string {
  if (typeof html !== "string" || !html.trim()) return "";
  const mailSafe = sanitizeForQuote(capped(html));
  const clean = sanitiseHtml(mailSafe);
  return clean.length > MAX_PASTE_CHARS + 32 ? sanitiseHtml(clean.slice(0, MAX_PASTE_CHARS)) : clean;
}

/** Escaped editor markup from clipboard text, line breaks kept. */
export function pastedTextToHtml(text: string): string {
  if (typeof text !== "string") return "";
  return textToHtml(capped(text).replace(/\r\n?/g, "\n")).replace(/&#39;/g, "'");
}

/**
 * A link target typed by the owner, or null when it is not allowed. Only
 * http, https and mailto; a bare domain becomes https and a bare address
 * becomes mailto.
 */
export function linkTarget(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 2_048 || /[\s<>"]/.test(text)) return null;
  let candidate = text;
  if (/^[^@/:]+@[^@/:]+\.[^@/:]+$/.test(text)) candidate = `mailto:${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) candidate = `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (url.protocol === "mailto:") return url.href;
  if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".")) return url.href;
  return null;
}
