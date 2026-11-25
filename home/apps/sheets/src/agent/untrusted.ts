/**
 * Marking spreadsheet content as untrusted data inside a prompt.
 *
 * Cell text comes from the file and may hold instructions aimed at the
 * model. It is wrapped in the markers of the kernel's external-content
 * wrapper (packages/kernel/src/security/external-content.ts), so every Matrix
 * agent reads the same convention; default apps cannot import the kernel, so
 * the few lines are repeated here.
 */

export const OPEN_MARKER = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
export const CLOSE_MARKER = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";

const MARKER_PATTERN = /<<<\s*(?:END_)?EXTERNAL_UNTRUSTED_CONTENT\s*>>>/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Replaces anything that looks like a marker, including full-width look-alikes. */
export function sanitizeMarkers(content: string): string {
  let result = content.replace(/＜/g, "<").replace(/＞/g, ">");
  let previous = "";
  while (previous !== result) {
    previous = result;
    result = result.replace(MARKER_PATTERN, "[SANITIZED]");
  }
  return result;
}

/** Removes control characters, keeping tab and line breaks. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL, "");
}

export const TRUNCATION_NOTE = "\n[truncated]";

/** Cuts `text` to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_NOTE.length) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}

/** One line without control characters, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = stripControlChars(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Wraps untrusted text so the model reads it as data, never as instructions. `label` is written by the app. */
export function wrapUntrusted(content: string, label: string): string {
  return [OPEN_MARKER, `Block: ${oneLine(label, 200)}`, "---", sanitizeMarkers(stripControlChars(content)), CLOSE_MARKER].join("\n");
}

/** Characters a wrapped block adds around its content. */
export function wrapOverhead(label: string): number {
  return wrapUntrusted("", label).length;
}
