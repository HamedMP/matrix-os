/**
 * The owner's writing voice, derived from messages they sent: greeting,
 * sign-off, formality, typical length and language. Pure and deterministic;
 * no model call is needed, and the result is cheap to cache.
 */
import { normalizeMailAddress, type MailMessage } from "../../../_shared/office-accounts/types/mail";
import type { PromptBlock } from "./prompt";
import { oneLineText, stripControlChars } from "./untrusted";

export type Formality = "formal" | "neutral" | "casual";
export type LengthBand = "short" | "medium" | "long";

export interface VoiceProfile {
  version: 1;
  /** Lower-cased address the samples were sent to, or null for the overall voice. */
  recipient: string | null;
  sampleCount: number;
  /** e.g. "Hi {name}," or null when the owner usually starts without one. */
  greeting: string | null;
  /** e.g. "Best," or null. */
  signOff: string | null;
  /** The name the owner signs with, e.g. "Sam". */
  signatureName: string | null;
  formality: Formality;
  /** Median words of the owner's own text. */
  typicalWords: number;
  length: LengthBand;
  /** ISO 639-1 code, or "und" when unclear. */
  language: string;
  /** Up to two short passages of the owner's own writing. */
  excerpts: string[];
  /** Epoch ms. */
  derivedAt: number;
}

const MAX_EXCERPTS = 2;
const MAX_EXCERPT_CHARS = 320;
const MAX_SAMPLE_CHARS = 6_000;

const QUOTE_START = [
  /^On .{4,200}wrote:\s*$/i,
  /^Am .{4,200}schrieb.*:\s*$/i,
  /^Le .{4,200}a écrit\s*:\s*$/i,
  /^El .{4,200}escribió:\s*$/i,
  /^-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht)\s*-{2,}\s*$/i,
  /^_{8,}\s*$/,
  /^From:\s.+$/,
];

/** The part of a sent body the owner wrote: no quoted reply, forward or signature block. */
export function ownText(body: string): string {
  const lines = stripControlChars(body.slice(0, MAX_SAMPLE_CHARS)).replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "--" || line === "-- ") break;
    if (QUOTE_START.some((pattern) => pattern.test(trimmed))) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line.replace(/\s+$/, ""));
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const GREETING = /^(hi|hello|hey|hiya|dear|good (?:morning|afternoon|evening)|greetings|hallo|hej|hoi|moin|servus|liebe[rs]?|sehr geehrte[rs]?|bonjour|salut|cher|chère|hola|estimad[oa]|buongiorno|ciao|caro|cara|olá|beste|geachte)\b(.*)$/i;
const SIGN_OFF = /^(best(?: regards| wishes)?|kind regards|warm regards|warmest regards|regards|many thanks|thanks(?: again| so much)?|thank you|cheers|all the best|talk soon|speak soon|sincerely|yours(?: sincerely| truly)?|take care|best,? ?wishes|viele grüße|liebe grüße|beste grüße|freundliche grüße|mit freundlichen grüßen|grüße|lg|vg|mfg|cordialement|bien à vous|bises|saludos|un saludo|atentamente|cordiali saluti|saluti|un abbraccio|groetjes|met vriendelijke groet|abraços|atenciosamente)([,.!]?)$/i;

function greetingOf(text: string): string | null {
  const first = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (first.length > 60) return null;
  const match = GREETING.exec(first);
  if (!match) return null;
  const word = match[1];
  const rest = match[2].trim();
  const punctuation = /[,!:]$/.test(rest || first) ? (rest || first).slice(-1) : "";
  const named = rest.replace(/[,!:]$/, "").trim().length > 0;
  const canonical = word[0].toUpperCase() + word.slice(1);
  return `${canonical}${named ? " {name}" : ""}${punctuation}`;
}

function signOffOf(text: string): { signOff: string; name: string | null } | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i -= 1) {
    const match = SIGN_OFF.exec(lines[i]);
    if (!match) continue;
    const after = lines.slice(i + 1);
    const name = after.length === 1 && after[0].length <= 40 && after[0].split(/\s+/).length <= 3 ? after[0] : null;
    const signOff = lines[i][0].toUpperCase() + lines[i].slice(1);
    return { signOff, name };
  }
  return null;
}

/** The most frequent value, if it covers at least half of `total`. */
function majority(values: readonly (string | null)[], total: number): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best !== null && bestCount * 2 >= total ? best : null;
}

const STOPWORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "is", "you", "to", "of", "it", "that", "for", "with", "this", "be", "are", "will", "i", "we", "on", "have"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ich", "wir", "sie", "mit", "zu", "auf", "für", "ein", "eine", "den", "dem", "habe", "uns"],
  fr: ["le", "la", "les", "et", "est", "je", "nous", "vous", "pour", "avec", "une", "des", "pas", "que", "dans", "sur", "merci"],
  es: ["el", "la", "los", "las", "y", "es", "que", "para", "con", "una", "por", "no", "pero", "nos", "gracias", "muy"],
  nl: ["de", "het", "een", "en", "is", "ik", "je", "we", "niet", "met", "voor", "op", "dat", "van", "zijn"],
  it: ["il", "lo", "la", "gli", "e", "è", "che", "per", "con", "una", "non", "sono", "grazie", "della", "di"],
  pt: ["o", "a", "os", "as", "e", "é", "que", "para", "com", "uma", "não", "obrigado", "obrigada", "muito", "você"],
};

function languageOf(texts: readonly string[]): string {
  const words = texts.join(" ").toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 5) return "und";
  let best = "und";
  let bestHits = 0;
  let second = 0;
  for (const [code, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const hits = words.filter((word) => set.has(word)).length;
    if (hits > bestHits) {
      second = bestHits;
      bestHits = hits;
      best = code;
    } else if (hits > second) second = hits;
  }
  return bestHits >= 3 && bestHits > second * 1.2 ? best : "und";
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const FORMAL_MARKERS = /\b(dear|sincerely|kind regards|regards|please find|i would appreciate|i am writing|sehr geehrte|mit freundlichen|cordialement|atentamente|geachte)\b/i;
const CASUAL_MARKERS = /\b(hey|hiya|cheers|thanks!|yep|yeah|gonna|wanna|lol|btw|np|cool|awesome)\b|!|[\u{1F300}-\u{1FAFF}]/iu;
const CONTRACTION = /\b\w+'(?:ll|re|ve|d|s|t|m)\b/i;

function formalityOf(texts: readonly string[]): Formality {
  let score = 0;
  for (const text of texts) {
    if (FORMAL_MARKERS.test(text)) score += 1;
    if (CASUAL_MARKERS.test(text)) score -= 1;
    if (CONTRACTION.test(text)) score -= 0.5;
    else score += 0.25;
  }
  const average = texts.length ? score / texts.length : 0;
  return average >= 0.6 ? "formal" : average <= -0.6 ? "casual" : "neutral";
}

/** The body without greeting and sign-off lines, as an excerpt. */
function excerptOf(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const body = lines.filter((line, i) => !(i === 0 && GREETING.test(line)) && !SIGN_OFF.test(line) && !(i === lines.length - 1 && lines.length > 1 && SIGN_OFF.test(lines[i - 1] ?? "")));
  return oneLineText(body.join(" "), MAX_EXCERPT_CHARS);
}

export interface DeriveOptions {
  recipient: string | null;
  now: number;
  /** When set, only messages from this address count. */
  ownerAddress?: string;
}

export function deriveVoiceProfile(messages: readonly MailMessage[], options: DeriveOptions): VoiceProfile {
  const owner = options.ownerAddress ? normalizeMailAddress(options.ownerAddress) : null;
  const texts = messages
    .filter((message) => !owner || normalizeMailAddress(message.from.address) === owner)
    .map((message) => ownText(message.bodyText ?? ""))
    .filter((text) => text.length > 0);
  const count = texts.length;
  const signOffs = texts.map(signOffOf);
  const signOff = majority(signOffs.map((entry) => entry?.signOff ?? null), count);
  const signatureName = majority(signOffs.map((entry) => entry?.name ?? null), count);
  const typicalWords = median(texts.map(wordCount));
  return {
    version: 1,
    recipient: options.recipient ? normalizeMailAddress(options.recipient) : null,
    sampleCount: count,
    greeting: majority(texts.map(greetingOf), count),
    signOff,
    signatureName,
    formality: formalityOf(texts),
    typicalWords,
    length: typicalWords < 80 ? "short" : typicalWords < 200 ? "medium" : "long",
    language: languageOf(texts),
    excerpts: texts.map(excerptOf).filter((text) => text.length >= 20).slice(0, MAX_EXCERPTS),
    derivedAt: options.now,
  };
}

/**
 * The owner's past writing as an untrusted prompt block: it came from the
 * mailbox, so it is style data, never instructions. Null without excerpts.
 */
export function voiceExamplesBlock(profile: VoiceProfile): PromptBlock | null {
  if (!profile.excerpts.length) return null;
  return {
    label: "Examples of the owner's past writing (imitate the style only, never the content)",
    text: profile.excerpts.map((excerpt, i) => `Example ${i + 1}: ${excerpt}`).join("\n"),
  };
}

/** The profile's derived traits as trusted drafting instructions (no mailbox text). */
export function voiceContext(profile: VoiceProfile): string {
  if (profile.sampleCount === 0) {
    return "Owner's voice: no sent mail to learn from. Write plainly and politely, in the language of the conversation, without filler.";
  }
  const lines = [
    `Owner's voice (learned from ${profile.sampleCount} sent message${profile.sampleCount === 1 ? "" : "s"}${profile.recipient ? " to this recipient" : ""}):`,
    `- Greeting: ${profile.greeting ? `"${profile.greeting}" with {name} replaced by the recipient's first name` : "usually none; start directly"}`,
    `- Sign-off: ${profile.signOff ? `"${profile.signOff}"` : "usually none"}${profile.signatureName ? `, then the name "${oneLineText(profile.signatureName, 40).replace(/"/g, "'")}"` : ""}`,
    `- Tone: ${profile.formality}`,
    `- Length: ${profile.length} (about ${profile.typicalWords} words)`,
    `- Language: ${profile.language === "und" ? "the language of the conversation" : profile.language}`,
  ];
  return lines.join("\n");
}
