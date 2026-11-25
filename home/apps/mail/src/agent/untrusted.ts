/**
 * Marking mailbox and pasted content as untrusted data inside a prompt.
 *
 * The markers match the kernel's external-content wrapper
 * (packages/kernel/src/security/external-content.ts) so every Matrix agent
 * reads the same convention. Default apps cannot import the kernel, so the
 * few lines are repeated here.
 */

export const OPEN_MARKER = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
export const CLOSE_MARKER = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";

const MARKER_PATTERN = /<<<\s*(?:END_)?EXTERNAL_UNTRUSTED_CONTENT\s*>>>/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Replaces anything that looks like a marker, including full-width look-alikes. */
export function sanitizeMarkers(content: string): string {
  if (!content) return content;
  let result = content.replace(/＜/g, "<").replace(/＞/g, ">");
  let previous = "";
  while (previous !== result) {
    previous = result;
    result = result.replace(MARKER_PATTERN, "[SANITIZED]");
  }
  return result;
}

/** Removes control characters (keeps tab and line breaks). */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL, "");
}

/** One line, no control characters, at most `max` characters. */
export function oneLineText(text: string, max: number): string {
  const flat = stripControlChars(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

export const TRUNCATION_NOTE = "\n[truncated]";

/** Cuts `text` to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_NOTE.length) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}

export interface UntrustedHeader {
  /** What the block is, e.g. "Message 2 of 5". Trusted, written by the app. */
  label: string;
  from?: string;
  to?: string;
  date?: string;
  subject?: string;
  attachments?: readonly string[];
}

/** Header lines describing a block; every value is flattened to one line. */
export function untrustedHeaderLines(header: UntrustedHeader): string[] {
  const value = (text: string) => sanitizeMarkers(oneLineText(text, 300));
  const lines = [`Block: ${value(header.label)}`];
  if (header.from) lines.push(`From: ${value(header.from)}`);
  if (header.to) lines.push(`To: ${value(header.to)}`);
  if (header.date) lines.push(`Date: ${value(header.date)}`);
  if (header.subject) lines.push(`Subject: ${value(header.subject)}`);
  if (header.attachments?.length) lines.push(`Attachments: ${header.attachments.map(value).join("; ")}`);
  return lines;
}

/** The block without its content, for measuring overhead. */
export function wrapOverhead(header: UntrustedHeader): number {
  return wrapUntrusted("", header).length;
}

/** Wraps untrusted text so the model reads it as data, never as instructions. */
export function wrapUntrusted(content: string, header: UntrustedHeader): string {
  return [OPEN_MARKER, ...untrustedHeaderLines(header), "---", sanitizeMarkers(stripControlChars(content)), CLOSE_MARKER].join("\n");
}
