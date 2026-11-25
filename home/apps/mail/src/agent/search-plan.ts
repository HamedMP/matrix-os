/**
 * Planning an agentic mail search: a natural question with partial context
 * ("the document Dana pushed back on in September") becomes structured hints
 * and then several provider queries, each a different strategy, so a vague
 * memory still finds the thread.
 */
import type { MailProviderId } from "../../../_shared/office-accounts/types/mail";
import type { Validator } from "./ai";
import { MAX_SEARCH_QUERIES_PER_ACCOUNT } from "./limits";
import { buildPrompt } from "./prompt";

export type SearchStrategy = "sender_date" | "conversation" | "topic" | "subject" | "attachment";

export interface SearchHints {
  /** Names, addresses or domains of people who wrote. */
  senders: string[];
  recipients: string[];
  /** Topic words likely in the body or subject. */
  keywords: string[];
  subjectTerms: string[];
  /** Words likely in an attachment's file name. */
  attachmentTerms: string[];
  wantsAttachment: boolean;
  /** Inclusive, `YYYY-MM-DD`. */
  after: string | null;
  /** Exclusive, `YYYY-MM-DD`. */
  before: string | null;
}

export interface PlannedQuery {
  strategy: SearchStrategy;
  /** In the provider's own search syntax. */
  query: string;
  /** How strongly a hit on this strategy counts when ranking. */
  weight: number;
}

const MAX_TERMS = 4;
const MAX_TERM_CHARS = 64;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyHints(): SearchHints {
  return { senders: [], recipients: [], keywords: [], subjectTerms: [], attachmentTerms: [], wantsAttachment: false, after: null, before: null };
}

/** A search term without characters that could change the query's structure. */
export function cleanTerm(term: string): string {
  // eslint-disable-next-line no-control-regex
  return term.replace(/["\\:(){}\[\]<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_TERM_CHARS).trim();
}

function terms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value.filter((item): item is string => typeof item === "string").map(cleanTerm).filter((item) => item.length >= 2);
  return [...new Set(cleaned)].slice(0, MAX_TERMS);
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

export const validateHints: Validator<SearchHints> = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  let after = validDate(r.after);
  let before = validDate(r.before);
  if (after && before && after >= before) [after, before] = [null, null];
  return {
    senders: terms(r.senders),
    recipients: terms(r.recipients),
    keywords: terms(r.keywords),
    subjectTerms: terms(r.subjectTerms),
    attachmentTerms: terms(r.attachmentTerms),
    wantsAttachment: r.wantsAttachment === true || terms(r.attachmentTerms).length > 0,
    after,
    before,
  };
};

export const HINTS_SCHEMA = '{"senders": string[], "recipients": string[], "keywords": string[], "subjectTerms": string[], "attachmentTerms": string[], "wantsAttachment": boolean, "after": "YYYY-MM-DD" | null, "before": "YYYY-MM-DD" | null}';

export function buildHintsPrompt(question: string, today: string): string {
  return buildPrompt({
    task: "Turn the owner's question about their mailbox into search hints. The owner may remember only part of it: a rough date, a person, a topic or a document.",
    schema: HINTS_SCHEMA,
    rules: [
      `Today is ${today}. Turn relative dates into a range and widen rough dates generously (for "in September" use the whole month plus a week either side; for "a few weeks ago" use the last two months).`,
      "Use null for dates the owner did not hint at. Use at most 4 short terms per list; prefer distinctive words; leave out filler words.",
      "When the owner mentions a document, file, deck, contract or sheet, set wantsAttachment and put likely file-name words in attachmentTerms.",
    ],
    instruction: question,
    blocks: [],
  });
}

const STOPWORDS = new Set("a an the and or but of to in on at for from with about that this those these was were is are be been find show me my mail email emails message messages thread threads where which what when who whom did does do they them their he she him her his it its we our you your i last ago some few weeks week months month year days day sent send pushed back".split(" "));
const ATTACHMENT_WORDS = /\b(attach\w*|document|doc|docx|file|pdf|deck|slides?|contract|sheet|spreadsheet|xlsx|invoice|proposal|draft|redline)\b/i;
const EMAIL = /[^\s<>(),;:"]+@[^\s<>(),;:"]+\.[A-Za-z]{2,}/g;

/** Hints from the question alone, without a model: addresses, quoted phrases and distinctive words. */
export function heuristicHints(question: string): SearchHints {
  const hints = emptyHints();
  const emails = question.match(EMAIL) ?? [];
  hints.senders = terms(emails);
  const quoted = [...question.matchAll(/"([^"]{2,64})"/g)].map((match) => match[1]);
  const rest = question.replace(EMAIL, " ").replace(/"[^"]*"/g, " ");
  const words = (rest.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.-]{2,}/gu) ?? []).filter((word) => !STOPWORDS.has(word));
  hints.keywords = terms([...quoted, ...words]);
  hints.wantsAttachment = ATTACHMENT_WORDS.test(question);
  return hints;
}

/** Model hints first, heuristic ones filling gaps. */
export function mergeHints(primary: SearchHints, extra: SearchHints): SearchHints {
  const join = (a: string[], b: string[]) => [...new Set([...a, ...b])].slice(0, MAX_TERMS);
  return {
    senders: join(primary.senders, extra.senders),
    recipients: join(primary.recipients, extra.recipients),
    keywords: primary.keywords.length ? primary.keywords : extra.keywords,
    subjectTerms: primary.subjectTerms,
    attachmentTerms: primary.attachmentTerms,
    wantsAttachment: primary.wantsAttachment || extra.wantsAttachment,
    after: primary.after ?? extra.after,
    before: primary.before ?? extra.before,
  };
}

function phrase(term: string): string {
  return /\s/.test(term) ? `"${term}"` : term;
}

function either(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `(${parts.join(" OR ")})`;
}

function dateParts(hints: SearchHints, provider: MailProviderId): string[] {
  const parts: string[] = [];
  if (provider === "gmail") {
    if (hints.after) parts.push(`after:${hints.after.replace(/-/g, "/")}`);
    if (hints.before) parts.push(`before:${hints.before.replace(/-/g, "/")}`);
  } else {
    if (hints.after) parts.push(`received>=${hints.after}`);
    if (hints.before) parts.push(`received<${hints.before}`);
  }
  return parts;
}

/**
 * Up to `MAX_SEARCH_QUERIES_PER_ACCOUNT` queries in the provider's syntax,
 * one per strategy that the hints support, without duplicates.
 */
export function planQueries(hints: SearchHints, provider: MailProviderId): PlannedQuery[] {
  const gmail = provider === "gmail";
  const dates = dateParts(hints, provider);
  const keywords = either(hints.keywords.map(phrase));
  const planned: PlannedQuery[] = [];
  const add = (strategy: SearchStrategy, parts: string[], weight: number) => {
    const query = parts.filter(Boolean).join(" ").trim();
    if (query && !planned.some((entry) => entry.query === query)) planned.push({ strategy, query, weight });
  };

  for (const sender of hints.senders.slice(0, 2)) add("sender_date", [`from:${phrase(sender)}`, ...dates], 2);
  const person = hints.senders[0] ?? hints.recipients[0];
  if (person && keywords) {
    const who = gmail ? `{from:${phrase(person)} to:${phrase(person)}}` : `participants:${phrase(person)}`;
    add("conversation", [who, keywords], 2);
  }
  if (hints.wantsAttachment || hints.attachmentTerms.length) {
    const names = hints.attachmentTerms.map((term) => (gmail ? `filename:${phrase(term)}` : `attachment:${phrase(term)}`));
    add("attachment", [gmail ? "has:attachment" : "hasattachments:true", either(names), person ? `from:${phrase(person)}` : "", ...dates], hints.attachmentTerms.length ? 2 : 1.5);
  }
  if (hints.subjectTerms.length) add("subject", [either(hints.subjectTerms.map((term) => `subject:${phrase(term)}`)), ...dates], 1.5);
  if (keywords) add("topic", [keywords, ...dates], 1);
  if (!planned.length && dates.length) add("topic", dates, 0.5);
  return planned.slice(0, MAX_SEARCH_QUERIES_PER_ACCOUNT);
}
