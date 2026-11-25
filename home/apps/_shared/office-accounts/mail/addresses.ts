/**
 * Address-list parsing for RFC 5322 header values such as
 * `"Doe, Jane" <jane@example.com>, bob@example.com (Bob), Team: a@x.org, b@x.org;`.
 * The scanner is linear and never throws; anything it cannot read as an
 * address is dropped.
 */
import { normalizeMailAddress, type MailAddress } from "../types/mail.js";
import { decodeEncodedWords, stripControl } from "./text.js";

/** Upper bound on header text read; a longer header is cut. */
const MAX_HEADER_CHARS = 64_000;
const MAX_ADDRESSES = 500;

/** Splits on commas and semicolons that are outside quotes, angle brackets and comments. */
function splitList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      current += char;
      if (char === "\\" && index + 1 < value.length) current += value[++index];
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === "(") comment++;
    else if (char === ")" && comment > 0) comment--;
    else if (char === "<" && comment === 0) angle++;
    else if (char === ">" && angle > 0) angle--;
    else if ((char === "," || char === ";") && angle === 0 && comment === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** Drops a leading `Group name:` outside quotes and angle brackets. */
function withoutGroupName(part: string): string {
  let quoted = false;
  for (let index = 0; index < part.length; index++) {
    const char = part[index];
    if (char === "\\" && quoted) { index++; continue; }
    if (char === "\"") quoted = !quoted;
    else if (!quoted && (char === "<" || char === "@")) return part;
    else if (!quoted && char === ":") return part.slice(index + 1);
  }
  return part;
}

function cleanName(name: string): string | undefined {
  const text = stripControl(decodeEncodedWords(unquote(name))).replace(/\s+/g, " ").trim();
  return text || undefined;
}

function parseOne(raw: string): MailAddress | null {
  const part = withoutGroupName(raw).trim();
  if (!part) return null;
  const open = part.lastIndexOf("<");
  const close = part.lastIndexOf(">");
  if (open !== -1 && close > open) {
    const address = part.slice(open + 1, close).trim();
    if (!address.includes("@")) return null;
    const name = cleanName(part.slice(0, open));
    return name ? { name, address: normalizeMailAddress(address) } : { address: normalizeMailAddress(address) };
  }
  const commentStart = part.indexOf("(");
  const commentEnd = part.lastIndexOf(")");
  const comment = commentStart !== -1 && commentEnd > commentStart ? part.slice(commentStart + 1, commentEnd) : "";
  const address = (commentStart === -1 ? part : part.slice(0, commentStart) + part.slice(commentEnd + 1)).trim();
  if (!address.includes("@") || /\s/.test(address)) return null;
  const name = cleanName(comment);
  return name ? { name, address: normalizeMailAddress(address) } : { address: normalizeMailAddress(address) };
}

/** Every address in a header value, in order, lower-cased, at most 500. */
export function parseAddressList(value: string | null | undefined): MailAddress[] {
  if (!value) return [];
  const text = value.length > MAX_HEADER_CHARS ? value.slice(0, MAX_HEADER_CHARS) : value;
  const out: MailAddress[] = [];
  for (const part of splitList(text.replace(/\r?\n[ \t]*/g, " "))) {
    const parsed = parseOne(part);
    if (parsed) out.push(parsed);
    if (out.length >= MAX_ADDRESSES) break;
  }
  return out;
}

/** The first address in a header value, or an empty address. */
export function parseAddress(value: string | null | undefined): MailAddress {
  return parseAddressList(value)[0] ?? { address: "" };
}

/** Removes repeats by address, keeping the first one (and the first name seen). */
export function uniqueAddresses(addresses: readonly MailAddress[]): MailAddress[] {
  const seen = new Map<string, MailAddress>();
  for (const entry of addresses) {
    const key = normalizeMailAddress(entry.address);
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) seen.set(key, { ...entry, address: key });
    else if (!existing.name && entry.name) existing.name = entry.name;
    if (seen.size >= MAX_ADDRESSES) break;
  }
  return [...seen.values()];
}
