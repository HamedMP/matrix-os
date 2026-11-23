/**
 * Recipient fields: splitting what the owner typed or pasted into addresses,
 * validating each one, and keeping the chip lists free of duplicates.
 *
 * Parsing is deliberately strict. A part is either a bare address or
 * `Name <address>` / `"Name" <address>`; group syntax, comments and anything
 * with a colon are reported as invalid instead of being guessed at, so a
 * pasted `Bcc: someone@example.com` can never smuggle in a recipient.
 */
import {
  MAX_DRAFT_RECIPIENTS,
  isValidMailAddress,
  normalizeMailAddress,
  type MailAddress,
} from "../../../_shared/office-accounts/types/mail";

/** Longest recipient text read at once; a longer paste is cut. */
export const MAX_RECIPIENT_INPUT_CHARS = 20_000;
/** Longest invalid entry kept for display. */
const MAX_INVALID_CHARS = 254;
const MAX_NAME_CHARS = 200;

export interface ParsedRecipients {
  valid: MailAddress[];
  /** The parts that are not a usable address, as typed (trimmed, capped). */
  invalid: string[];
}

/** Splits on commas, semicolons and line breaks outside quotes and angle brackets. */
export function splitRecipientText(text: string): string[] {
  const source = text.length > MAX_RECIPIENT_INPUT_CHARS ? text.slice(0, MAX_RECIPIENT_INPUT_CHARS) : text;
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      current += char;
      if (char === "\\" && index + 1 < source.length) current += source[++index];
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\r" || char === "\n") {
      // A line break always ends an entry, even inside brackets: headers never span lines here.
      angle = false;
      push();
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === "<") angle = true;
    else if (char === ">") angle = false;
    else if ((char === "," || char === ";") && !angle) {
      push();
      continue;
    }
    current += char;
  }
  push();
  return parts;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function cleanName(raw: string): string | undefined {
  let name = raw.trim();
  if (name.length >= 2 && name.startsWith("\"") && name.endsWith("\"")) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  name = name.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS) : name;
}

/** One entry as an address, or null when it is not a usable one. */
export function parseRecipient(part: string): MailAddress | null {
  const text = part.trim();
  if (!text) return null;
  const angled = /^((?:"(?:[^"\\]|\\.)*")|[^<>"]*)\s*<([^<>]*)>$/.exec(text);
  if (angled) {
    const address = normalizeMailAddress(angled[2]);
    if (!isValidMailAddress(address)) return null;
    if (/[:;]/.test(angled[1].replace(/"(?:[^"\\]|\\.)*"/g, ""))) return null;
    const name = cleanName(angled[1]);
    return name && name !== address ? { name, address } : { address };
  }
  const address = normalizeMailAddress(text);
  return isValidMailAddress(address) ? { address } : null;
}

/** Every entry in `text`, split into usable addresses and the rest. */
export function parseRecipients(text: string): ParsedRecipients {
  const valid: MailAddress[] = [];
  const invalid: string[] = [];
  for (const part of splitRecipientText(text)) {
    const parsed = parseRecipient(part);
    if (parsed) valid.push(parsed);
    else invalid.push(part.length > MAX_INVALID_CHARS ? `${part.slice(0, MAX_INVALID_CHARS - 1)}…` : part);
  }
  return { valid, invalid };
}

/**
 * Splits the text of a recipient input into what should become chips now
 * (everything before the last separator) and what the owner is still typing.
 */
export function pendingRecipientText(text: string): { commit: string; rest: string } {
  const lastSeparator = Math.max(text.lastIndexOf(","), text.lastIndexOf(";"), text.lastIndexOf("\n"));
  if (lastSeparator < 0) return { commit: "", rest: text };
  const commit = text.slice(0, lastSeparator).trim();
  const rest = text.slice(lastSeparator + 1).trimStart();
  // A separator inside an unfinished quote or bracket is not a separator yet.
  if (splitRecipientText(text).length === splitRecipientText(commit).length + (rest ? 1 : 0)) return { commit, rest };
  return { commit: "", rest: text };
}

/** `existing` followed by the new addresses it does not have yet, at most the provider limit. */
export function mergeRecipients(existing: readonly MailAddress[], added: readonly MailAddress[]): MailAddress[] {
  const seen = new Set(existing.map((entry) => normalizeMailAddress(entry.address)));
  const result = existing.slice(0, MAX_DRAFT_RECIPIENTS);
  for (const entry of added) {
    if (result.length >= MAX_DRAFT_RECIPIENTS) break;
    const address = normalizeMailAddress(entry.address);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    result.push(entry.name ? { name: entry.name, address } : { address });
  }
  return result;
}

export function removeRecipient(list: readonly MailAddress[], address: string): MailAddress[] {
  const target = normalizeMailAddress(address);
  return list.filter((entry) => normalizeMailAddress(entry.address) !== target);
}
