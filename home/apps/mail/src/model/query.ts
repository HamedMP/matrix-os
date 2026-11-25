/**
 * The Mail search language and the instant local filter.
 *
 *   from:alice  to:bob  subject:"q3 report"  has:attachment
 *   is:unread  is:read  is:flagged (is:starred)  before:2026-11-20  after:2026-11-01
 *
 * Everything else is free text. Terms combine with AND. A date is the start
 * of that day in the owner's zone; `after:` includes the day, `before:`
 * excludes it. Values are matched case-insensitively.
 *
 * Locally, `from:` and `to:` match any participant (a summary does not say
 * who sent what); the provider search applies the exact header.
 */
import {
  instantFromWallTime,
  instantToMs,
  type IsoInstant,
  type MailProviderId,
  type ThreadSummary,
} from "../../../_shared/office-accounts/types/mail";

export interface MailQuery {
  /** The trimmed input. */
  raw: string;
  text: string[];
  from: string[];
  to: string[];
  subject: string[];
  hasAttachment: boolean | null;
  unread: boolean | null;
  flagged: boolean | null;
  /** Inclusive lower bound. */
  after: IsoInstant | null;
  /** Exclusive upper bound. */
  before: IsoInstant | null;
  /** The dates as typed, `YYYY-MM-DD`, for provider syntax. */
  afterDate: string | null;
  beforeDate: string | null;
}

export const MAX_QUERY_CHARS = 512;
export const MAX_QUERY_TERMS = 32;

const DATE = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;
// Control characters and the characters that could break out of a provider query.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      if (tokens.length >= MAX_QUERY_TERMS) return tokens;
      continue;
    }
    current += char;
  }
  if (current && tokens.length < MAX_QUERY_TERMS) tokens.push(current);
  return tokens;
}

function cleanValue(value: string): string {
  return value.replace(/["\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseDate(value: string, timeZone: string): { instant: IsoInstant; date: string } | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  try {
    return { instant: instantFromWallTime(`${date}T00:00:00`, timeZone), date };
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export function emptyMailQuery(): MailQuery {
  return {
    raw: "", text: [], from: [], to: [], subject: [],
    hasAttachment: null, unread: null, flagged: null,
    after: null, before: null, afterDate: null, beforeDate: null,
  };
}

export function parseMailQuery(input: string, options: { timeZone?: string } = {}): MailQuery {
  const timeZone = options.timeZone ?? "UTC";
  const raw = input.slice(0, MAX_QUERY_CHARS).replace(CONTROL, " ").trim();
  const query: MailQuery = { ...emptyMailQuery(), raw };
  for (const token of tokenize(raw)) {
    const colon = token.indexOf(":");
    const operator = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const value = cleanValue(colon > 0 ? token.slice(colon + 1) : token);
    if (!value) continue;
    if (operator === "from") query.from.push(value);
    else if (operator === "to") query.to.push(value);
    else if (operator === "subject") query.subject.push(value);
    else if (operator === "has" && value === "attachment") query.hasAttachment = true;
    else if (operator === "is" && value === "unread") query.unread = true;
    else if (operator === "is" && value === "read") query.unread = false;
    else if (operator === "is" && (value === "flagged" || value === "starred")) query.flagged = true;
    else if ((operator === "before" || operator === "after") && parseDate(value, timeZone)) {
      const parsed = parseDate(value, timeZone)!;
      if (operator === "before") {
        query.before = parsed.instant;
        query.beforeDate = parsed.date;
      } else {
        query.after = parsed.instant;
        query.afterDate = parsed.date;
      }
    } else query.text.push(cleanValue(token));
  }
  return query;
}

export function isEmptyQuery(query: MailQuery): boolean {
  return query.text.length === 0 && query.from.length === 0 && query.to.length === 0
    && query.subject.length === 0 && query.hasAttachment === null && query.unread === null
    && query.flagged === null && query.after === null && query.before === null;
}

function participantText(thread: ThreadSummary): string[] {
  return thread.participants.map((p) => `${p.name ?? ""} ${p.address}`.toLowerCase());
}

/** True when the cached summary satisfies every term of the query. */
export function matchesQuery(thread: ThreadSummary, query: MailQuery): boolean {
  if (query.unread !== null && thread.unread !== query.unread) return false;
  if (query.flagged !== null && thread.flagged !== query.flagged) return false;
  if (query.hasAttachment !== null && thread.hasAttachments !== query.hasAttachment) return false;
  if (query.after !== null || query.before !== null) {
    const at = safeMs(thread.lastMessageAt);
    if (at === null) return false;
    if (query.after !== null && at < instantToMs(query.after)) return false;
    if (query.before !== null && at >= instantToMs(query.before)) return false;
  }
  const people = participantText(thread);
  const inPeople = (term: string) => people.some((p) => p.includes(term));
  if (!query.from.every(inPeople) || !query.to.every(inPeople)) return false;
  const subject = thread.subject.toLowerCase();
  if (!query.subject.every((term) => subject.includes(term))) return false;
  if (query.text.length > 0) {
    const haystack = [subject, thread.snippet.toLowerCase(), ...people].join("\n");
    if (!query.text.every((term) => haystack.includes(term))) return false;
  }
  return true;
}

function safeMs(instant: string): number | null {
  try {
    return instantToMs(instant);
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function phrase(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The query in the provider's own search syntax, for `MailProvider.search`
 * and `ListThreadsRequest.query`. Values were stripped of quotes, backslashes
 * and control characters by the parser.
 */
export function toProviderQuery(query: MailQuery, provider: MailProviderId): string {
  const parts: string[] = [];
  for (const value of query.from) parts.push(`from:${phrase(value)}`);
  for (const value of query.to) parts.push(`to:${phrase(value)}`);
  for (const value of query.subject) parts.push(`subject:${phrase(value)}`);
  if (provider === "gmail") {
    if (query.hasAttachment) parts.push("has:attachment");
    if (query.unread === true) parts.push("is:unread");
    if (query.unread === false) parts.push("is:read");
    if (query.flagged) parts.push("is:starred");
    if (query.afterDate) parts.push(`after:${query.afterDate.replace(/-/g, "/")}`);
    if (query.beforeDate) parts.push(`before:${query.beforeDate.replace(/-/g, "/")}`);
  } else {
    if (query.hasAttachment) parts.push("hasattachments:true");
    if (query.unread !== null) parts.push(`isread:${query.unread ? "false" : "true"}`);
    if (query.flagged) parts.push("flag:flagged");
    if (query.afterDate) parts.push(`received>=${query.afterDate}`);
    if (query.beforeDate) parts.push(`received<${query.beforeDate}`);
  }
  for (const value of query.text) parts.push(phrase(value));
  return parts.join(" ");
}
