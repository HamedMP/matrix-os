/**
 * The rules extractor (BRAIN_RULES_EXTRACTOR_ID, raise BRAIN_RULES_VERSION in types.ts whenever its decisions change):
 * deterministic claims from the sections and labels the team writes in pull request, commit and spec bodies
 * (Invariants labels, Deferred scope, Decisions, Risks, Next steps, kind prefixes). Fences, HTML comments, tables,
 * images and trailers are skipped. Every quote is a verbatim substring of the source text at its UTF-16 span, and each
 * quote gives at most one claim. Pure.
 */
import { fenceOf, headingOf, parseBrainGitFooter } from "../why.js";
import {
  BRAIN_CLAIMS_PER_DOCUMENT_MAX, BRAIN_CLAIM_FOOTER_PROVENANCES, BRAIN_CLAIM_LABEL_MAX_CHARS,
  BRAIN_CLAIM_QUOTE_MAX_CHARS, BRAIN_CLAIM_STATEMENT_MAX_CHARS, type BrainClaimConfidence, type BrainClaimDraft,
  type BrainClaimExtraction, type BrainClaimKind, type BrainClaimSourceDocument,
} from "./types.js";
import { finalizeBrainClaims } from "./verify.js";

type SectionKind = "invariants" | "deferred" | "decisions" | "risks" | "commitments" | "none";

/**
 * future: the heading itself names later work (`Follow-up stack`), so every deferred item in it is a commitment.
 * notes: a sub-heading of a decisions section that does not name a decision itself (`Canvas Title Bars`); its items
 * often describe the design rather than choose it. held: unlabelled paragraph claims, kept only when the section ends
 * without bullet items.
 */
interface Section {
  readonly level: number; readonly kind: SectionKind; label: string | null; readonly future: boolean;
  readonly notes: boolean; bullets: boolean; readonly held: BrainClaimDraft[];
}

/** A bullet or paragraph; [start, end) is its text. skip: a checkbox. label: its own, set when it closes. */
interface Item {
  readonly indent: number; readonly start: number; end: number; readonly paragraph: boolean; readonly skip: boolean;
  readonly parent: Item | null; readonly section: Section; label: string | null;
}

/** A kind prefix or label at the start of an item; the statement starts at `rest`. */
interface Lead { readonly kind: BrainClaimKind | null; readonly label: string | null; readonly rest: number }

const DEFERRED_LABEL = "Deferred scope";
const CANONICAL_LABELS: readonly (readonly [RegExp, string])[] = [
  [/^source of truth$/, "Source of truth"],
  [new RegExp(String.raw`^(?:locks? ?/ ?transactions?(?: (?:scope|boundary))?|transactions? ?/ ?locks?(?: scope)?`
    + String.raw`|lock (?:and|or) transaction (?:scope|boundary)|transaction scope)$`), "Lock/transaction scope"],
  [/^(?:(?:acceptable )?orphan states|acceptable partial states)$/, "Acceptable orphan states"],
  [/^auth(?:entication|orization)?(?: source(?: of truth)?)?$/, "Auth source of truth"],
  [/^deferred(?: scope)?$/, DEFERRED_LABEL],
  [/^(?:resource (?:bounds|limits)|bounds)$/, "Resource bounds"],
];
const DEFERRED_SECTION_KEYS = ["follow-up stack", "explicit follow-up scope", "deferred follow-ups"];
/** In-scope wording (`Goals`, `In scope`) is never a claim section, even next to `Non-goals`; nor is a bare `Scope`. */
const IN_SCOPE = /(?<!non-?)\bgoals?\b|\bin[- ]scope\b/;
/** Open decisions and questions are undecided: never a claim section or a label for claims. */
const OPEN = /\bopen (?:decisions?|questions?)\b/i;
/** A bare auth heading is a feature section (`### Authentication`), not the Auth source of truth label. */
const BARE_AUTH = /^auth(?:entication|orization)?$/;
const BARE_HEADING = /^(?:\*\*)?[A-Z][^.!?]{1,58}(?:\*\*)?:?(?:\*\*)?$/;
/** Deeper than every ATX level (1-6), so the next heading of either kind ends a bare section. */
const BARE_HEADING_LEVEL = 7;
const BARE_HEADING_KEYS = ["summary", "tests", "validation", "verification", "invariants", "matrix invariants",
  "review/monitoring", "review / monitoring", "review and monitoring", "docs", "notes", "rationale", "stack", "rollout",
  "decisions", "risks", "deferred", "scope"];
/** Headings longer than this are prose, not section names. */
const HEADING_KEY_MAX_CHARS = 200;
const BOLD_LABEL = /^\*\*([^*\n]{1,60}?)(?::\*\*|\*\*:)/;
const BOLD_LABEL_MAX_WORDS = 6;
const PLAIN_LABEL = /^([^:\n*`]{1,60}):(?=\s|$)/;
const KIND_PREFIX = /^(\*\*)?(decisions?|risks?|follow[- ]?ups?|next steps?|todo)(:\*\*|\*\*:|:)(?=\s|$)/i;
const SEPARATOR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^( *)([-*+]|\d{1,3}[.)])\s+(\S.*)$/;
const CHECKBOX = /^\[[ xX]\](?:\s|$)/;
const SKIP_LINE = /^(?:\||!\[|co-authored-by:|signed-off-by:|\ud83e\udd16 generated|linear: |refs |claude-session:)/i;
const TRIVIAL = /^(?:none(?: introduced)?|n\/?a|not applicable|unchanged|untouched|not touched|no changes?|nothing)\.?$/i;
const PROCESS = /greptile|will not merge|merge gates?|ready-for-ci|exact-head|tests? passed|^`[^`]+` passed/i;
/** A deferred item that points at later work: "#2046", "in a follow-up", "the next layer", "(layer 5b)", ... */
const FUTURE = new RegExp([
  String.raw`\b(?:later|next|follow[- ]?ups?|upstack|tracked|future|subsequent|remains? deferred`,
  String.raw`deferred (?:to|until|upstack)|will (?:land|ship|follow|come|be)|lands?|ships? in|comes? in|follows? in`,
  String.raw`layer \d{1,3}[a-z]?)\b|#\d+|\bPRs? \d+`,
  String.raw`\bseparate (?:follow[- ]?up |stacked )?(?:prs?|issues?|slices?|changes?|work|layers?)\b`,
  String.raw`\b(?:own|separate|dedicated|later|final|follow-up) [\w-]+ (?:pr|layer|slice)\b`,
].join("|"), "i");
/**
 * Wording that states a choice: chose, decided, instead of, rather than, prefer, must, never, will, shall, a leading
 * imperative (`Use`, `Keep`, `Do not`), or `use` after we, to or a modal. `Rules use selectors` describes; it does not
 * choose.
 */
const CHOICE = new RegExp([
  String.raw`^(?:use|keep|choose|pick|adopt|avoid|do not|don't|always|only)\b`,
  String.raw`\b(?:cho(?:se|sen|osing)|decided?|decision|instead of|rather than|in favou?r of|prefer(?:s|red)?`,
  String.raw`must|never|shall|will|won't|(?:we|to|will|should|must|always|only) use)\b`,
].join("|"), "i");
/** Drafts kept per document before finalizing; later ones are only counted as rejected. */
const DRAFTS_MAX = 4 * BRAIN_CLAIMS_PER_DOCUMENT_MAX;
/** leadOf returns this very object when the text has no lead. */
const NO_LEAD: Lead = { kind: null, label: null, rest: 0 };

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** Without `**` and a trailing colon, whitespace collapsed. */
const bareName = (text: string): string => collapse(text.replaceAll("**", "")).replace(/\s*:$/, "");
const keyOf = (text: string): string => bareName(text).toLowerCase();

function canonicalLabel(text: string): string | null {
  const key = keyOf(text);
  return CANONICAL_LABELS.find(([pattern]) => pattern.test(key))?.[1] ?? null;
}

const isCanonical = (label: string | null): boolean => CANONICAL_LABELS.some(([, name]) => name === label);

const UNCLASSIFIED = { kind: "none", label: null } as const;
/**
 * classify returns these very objects for in-scope and open-question headings, which never open a nested claim section
 * either, even under a Decisions or Invariants heading.
 */
const IN_SCOPE_SECTION = { kind: "none", label: null } as const;
const OPEN_SECTION = { kind: "none", label: null } as const;

function classify(text: string): { readonly kind: SectionKind; readonly label: string | null } {
  if (text.length > HEADING_KEY_MAX_CHARS) return UNCLASSIFIED;
  const key = keyOf(text);
  if (OPEN.test(key)) return OPEN_SECTION;
  if (key.includes("invariant")) return { kind: "invariants", label: null };
  const canonical = BARE_AUTH.test(key) ? null : canonicalLabel(key);
  if (canonical !== null) return { kind: canonical === DEFERRED_LABEL ? "deferred" : "invariants", label: canonical };
  if (IN_SCOPE.test(key)) return IN_SCOPE_SECTION;
  if (/deferr|non-?goals?|out of scope/.test(key) || DEFERRED_SECTION_KEYS.includes(key)) {
    return { kind: "deferred", label: DEFERRED_LABEL };
  }
  // Review, Greptile and CI follow-ups describe done work.
  if (/follow[- ]?ups?/.test(key)) return UNCLASSIFIED;
  if (/\bdecisions?\b/.test(key)) return { kind: "decisions", label: null };
  if (/\brisks?\b/.test(key)) return { kind: "risks", label: null };
  if (/^scope\b/.test(key)) return IN_SCOPE_SECTION;
  return { kind: key === "next step" || key === "next steps" ? "commitments" : "none", label: null };
}

/** A heading's own words as a label, when they fit one. */
function verbatimLabel(text: string): string | null {
  const label = bareName(text);
  return label.length >= 1 && label.length <= BRAIN_CLAIM_LABEL_MAX_CHARS && !/\p{Cc}/u.test(label) ? label : null;
}

function boldName(raw: string): string | null {
  const name = collapse(raw);
  return name !== "" && name.split(" ").length <= BOLD_LABEL_MAX_WORDS ? name : null;
}

/** A kind prefix (`Decision:`, `**Risk:**`), a bold label (`**X:**`, `**X**:`) or a canonical plain label (`X: `). */
function leadOf(text: string): Lead {
  const prefix = KIND_PREFIX.exec(text);
  if (prefix !== null && (prefix[1] === "**") === (prefix[3] !== ":")) {
    const word = prefix[2]!.toLowerCase();
    const kind = word.startsWith("decision") ? "decision" : word.startsWith("risk") ? "risk" : "commitment";
    return { kind, label: null, rest: prefix[0].length };
  }
  const bold = BOLD_LABEL.exec(text);
  if (bold !== null) {
    const name = boldName(bold[1]!);
    return name === null ? NO_LEAD : { kind: null, label: canonicalLabel(name) ?? name, rest: bold[0].length };
  }
  const plain = PLAIN_LABEL.exec(text);
  const canonical = plain === null ? null : canonicalLabel(plain[1]!);
  return canonical === null ? NO_LEAD : { kind: null, label: canonical, rest: plain![0].length };
}

/** A bare line that only names a label (`Source of truth:`, `**Notes:**`); null when the line says more. */
function labelLine(trimmed: string): string | null {
  const canonical = canonicalLabel(trimmed);
  if (canonical !== null) return canonical;
  const bold = BOLD_LABEL.exec(trimmed);
  return bold !== null && bold[0].length === trimmed.length ? boldName(bold[1]!) : null;
}

const isBareHeading = (trimmed: string): boolean => BARE_HEADING.test(trimmed)
  && (trimmed.replaceAll("**", "").endsWith(":") || BARE_HEADING_KEYS.includes(keyOf(trimmed)));

function boundQuote(raw: string): string {
  let end = Math.min(raw.length, BRAIN_CLAIM_QUOTE_MAX_CHARS);
  if (end < raw.length && isHighSurrogate(raw.charCodeAt(end - 1))) end -= 1;
  return raw.slice(0, end).trimEnd();
}

/** Cut at the last space at or before the limit, else hard without splitting a surrogate pair; no ellipsis. */
function boundStatement(statement: string): string {
  const max = BRAIN_CLAIM_STATEMENT_MAX_CHARS;
  if (statement.length <= max) return statement;
  let cut = statement.lastIndexOf(" ", max);
  if (cut <= 0) cut = isHighSurrogate(statement.charCodeAt(max - 1)) ? max - 1 : max;
  return statement.slice(0, cut).trimEnd();
}

const newSection = (level: number, kind: SectionKind, label: string | null, future = false, notes = false): Section =>
  ({ level, kind, label, future, notes, bullets: false, held: [] });
