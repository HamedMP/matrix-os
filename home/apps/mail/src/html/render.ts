/** Picks the body part to show for a message and renders it safely. */
import { isBlank, parseBodyContent } from "./dom";
import { sanitizeEmailHtml, type SanitizedEmail, type SanitizeEmailOptions } from "./sanitize";
import { textToHtml } from "./text-to-html";

export interface MailBodyParts {
  /** The provider's HTML, unsanitised, or null. */
  html: string | null;
  /** The plain-text part. */
  text: string;
}

/** True when sanitised markup has nothing to look at: no text, no image and no image placeholder. */
export function isEmptyBody(html: string): boolean {
  if (html === "") return true;
  const body = parseBodyContent(html);
  return isBlank(body.textContent ?? "") && body.querySelector("img, span[role=img], hr") === null;
}

/**
 * Renders a message body: the HTML part when it has visible content, the
 * plain-text part otherwise. Both paths return the same shape.
 */
export function renderMailBody(parts: MailBodyParts, options: SanitizeEmailOptions = {}): SanitizedEmail {
  if (typeof parts.html === "string" && parts.html.trim() !== "") {
    const rich = sanitizeEmailHtml(parts.html, options);
    if (!isEmptyBody(rich.html) || rich.hasQuote || isBlank(parts.text ?? "")) return rich;
  }
  return textToHtml(parts.text, { quotes: options.quotes });
}
