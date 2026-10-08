/**
 * The rules extractor (BRAIN_RULES_EXTRACTOR_ID, raise BRAIN_RULES_VERSION in types.ts whenever its decisions change):
 * deterministic claims from the sections and labels the team writes in pull request, commit and spec bodies
 * (Invariants labels, Deferred scope, Decisions, Risks, Next steps, kind prefixes). Fences, HTML comments (from `<!--`
 * anywhere on a line), tables, images and trailers are skipped. Every quote is a verbatim substring of the source text
 * at its UTF-16 span, and each quote gives at most one claim. Pure.
 */
import { closesFence, fenceOf, headingOf, parseBrainGitFooter } from "../why.js";
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
/** A bullet marker with nothing after it, as left before a comment (`- <!-- note -->`): an empty line, not an item. */
const MARKER_ONLY = /^ *(?:[-*+]|\d{1,3}[.)])\s*$/;
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

/**
 * Whether an HTML comment opened at or after `from` in the line is still open at its end. A comment runs from `<!--`
 * anywhere on a line to the next `-->` after it, as verify.ts masks hidden text for model quotes.
 */
function commentOpenAtEnd(line: string, from: number): boolean {
  for (let start = line.indexOf("<!--", from); start >= 0;) {
    const close = line.indexOf("-->", start + 4);
    if (close < 0) return true;
    start = line.indexOf("<!--", close + 3);
  }
  return false;
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

/** Line scanner over `text`; calls `sink` with each draft. */
function scanClaims(text: string, sink: (draft: BrainClaimDraft) => void): void {
  const stack: Section[] = [newSection(0, "none", null)];
  let items: Item[] = [];
  let open: Item | null = null;
  let fence: { readonly char: string; readonly length: number } | null = null;
  let comment = false;
  const top = (): Section => stack[stack.length - 1]!;

  /** The item's own label, else its nearest labelled parent item's; null when only a section labels it. */
  const itemLabel = (item: Item): string | null => {
    for (let node: Item | null = item; node !== null; node = node.parent) if (node.label !== null) return node.label;
    return null;
  };

  /** One draft per item, so a quote is never stored under two kinds. */
  function draftOf(item: Item, lead: Lead, statement: string): BrainClaimDraft | null {
    const quote = boundQuote(text.slice(item.start, item.end));
    const own = itemLabel(item);
    const label = lead.kind !== null ? null : own ?? stack.findLast((section) => section.label !== null)?.label ?? null;
    const draft = (kind: BrainClaimKind, confidence: BrainClaimConfidence): BrainClaimDraft => ({
      kind, label, statement, quote, spanStart: item.start, spanEnd: item.start + quote.length, fields: {}, confidence,
    });
    if (label === null && PROCESS.test(statement)) return null;
    if (lead.kind !== null) return draft(lead.kind, "high");
    // Items under an `Open questions` label (their own or a parent bullet's) are undecided.
    if (own !== null && OPEN.test(own)) return null;
    const { kind, future, notes } = item.section;
    // A deferred item that points at later work is a commitment instead of an invariant; a deferred section is always
    // labelled.
    const later = kind === "deferred" ? future || FUTURE.test(statement)
      : kind === "invariants" && label === DEFERRED_LABEL && FUTURE.test(statement);
    if (later) return draft("commitment", "medium");
    if (kind === "invariants") return draft("invariant", isCanonical(label) ? "high" : "medium");
    if (kind === "deferred") return draft("invariant", "high");
    // A design note under a sub-heading of decisions is a decision only when it states a choice.
    if (kind === "decisions" && notes && own === null && !CHOICE.test(statement)) return null;
    return draft(kind === "decisions" ? "decision" : kind === "risks" ? "risk" : "commitment", "high");
  }

  function closeItem(): void {
    const item = open;
    open = null;
    if (item === null || item.skip) return;
    const raw = text.slice(item.start, item.end);
    const lead = leadOf(raw);
    item.label = lead.label;
    if (item.section.kind === "none" && lead.kind === null) return;
    const statement = boundStatement(collapse(raw.slice(lead.rest)));
    if (statement === "" || TRIVIAL.test(statement)) return;
    const draft = draftOf(item, lead, statement);
    if (draft === null) return;
    const counts = !item.paragraph || lead.kind !== null || lead.label !== null || item.section.label !== null;
    if (counts) sink(draft);
    else if (item.section.held.length < DRAFTS_MAX) item.section.held.push(draft);
  }

  function popSections(keep: (section: Section) => boolean): void {
    while (stack.length > 1 && !keep(top())) {
      const section = stack.pop()!;
      if (!section.bullets) section.held.forEach(sink);
    }
  }

  /**
   * A title (level 1), in-scope or open-question heading opens no section, even under a claim section. Any other
   * sub-heading of a claim section keeps its kind unless it names its own; deferred items stay `Deferred scope`, others
   * take the sub-heading's words as their label. A sub-heading that keeps a decisions kind holds design notes.
   */
  function enterHeading(level: number, headingText: string): void {
    popSections((section) => section.level < level);
    const parent = top();
    const classified = level === 1 ? UNCLASSIFIED : classify(headingText);
    const future = FUTURE.test(headingText);
    const closed = classified === IN_SCOPE_SECTION || classified === OPEN_SECTION;
    if (parent.kind === "none" || level === 1 || closed) {
      stack.push(newSection(level, classified.kind, classified.label, future));
      return;
    }
    const own = classified.kind === "deferred" || classified.kind === "decisions" || classified.kind === "risks";
    const kind = own ? classified.kind : parent.kind;
    const label = kind === "deferred" ? DEFERRED_LABEL : canonicalLabel(headingText) ?? verbatimLabel(headingText);
    stack.push(newSection(level, kind, label, future || parent.future, !own && kind === "decisions"));
  }

  /**
   * A bare label line inside a claim section labels it; any other bare heading, an open-question line included, starts
   * a new top-level section.
   */
  function enterBareHeading(trimmed: string): void {
    const classified = classify(trimmed);
    const label = top().kind === "none" || classified === OPEN_SECTION ? null : labelLine(trimmed);
    if (label !== null) {
      top().label = label;
      return;
    }
    popSections(() => false);
    stack.push(newSection(BARE_HEADING_LEVEL, classified.kind, classified.label, FUTURE.test(trimmed)));
  }

  function startItem(line: string, at: number, bullet: RegExpExecArray | null): void {
    const indent = bullet === null ? line.length - line.trimStart().length : bullet[1]!.length;
    const start = at + (bullet === null ? indent : bullet[0].length - bullet[3]!.length);
    if (bullet === null) items = [];
    while (items.length > 0 && items[items.length - 1]!.indent >= indent) items.pop();
    const skip = bullet !== null && CHECKBOX.test(bullet[3]!);
    open = {
      indent, start, end: at + line.trimEnd().length, paragraph: bullet === null, skip,
      parent: items[items.length - 1] ?? null, section: top(), label: null,
    };
    if (bullet === null) return;
    items.push(open);
    if (!skip) stack.forEach((section) => { section.bullets = true; });
  }

  function scanLine(line: string, at: number): void {
    if (fence !== null) {
      if (closesFence(fence, line)) fence = null;
      return;
    }
    if (comment) {
      const close = line.indexOf("-->");
      if (close >= 0) comment = commentOpenAtEnd(line, close + 3);
      return;
    }
    const cut = fenceOf(line) === null ? line.indexOf("<!--") : -1;
    if (cut < 0) {
      scanVisible(line, at);
      return;
    }
    // A comment hides the rest of its line and ends the open item, so no statement or quote reaches into it.
    const before = line.slice(0, cut);
    scanVisible(MARKER_ONLY.test(before) ? "" : before, at);
    closeItem();
    comment = commentOpenAtEnd(line, cut);
  }

  function scanVisible(line: string, at: number): void {
    const trimmed = line.trim();
    const opening = fenceOf(line);
    const heading = opening === null ? headingOf(line) : null;
    const bullet = BULLET.exec(line);
    const atMargin = trimmed !== "" && line[0] === trimmed[0];
    const bare = atMargin && bullet === null && isBareHeading(trimmed);
    const separator = atMargin && SEPARATOR.test(line);
    const skipped = SKIP_LINE.test(trimmed);
    const plain = trimmed !== "" && opening === null && heading === null && !bare && !separator && !skipped;
    if (plain && bullet === null && open !== null && !(open.paragraph && leadOf(trimmed) !== NO_LEAD)) {
      open.end = at + line.trimEnd().length;
      return;
    }
    closeItem();
    if (opening !== null || heading !== null || bare || separator) items = [];
    if (opening !== null) fence = opening;
    else if (heading !== null) enterHeading(heading.level, heading.text);
    else if (bare) enterBareHeading(trimmed);
    else if (separator) popSections(() => false);
    else if (plain) startItem(line, at, bullet);
  }

  for (let at = 0; at <= text.length;) {
    const newline = text.indexOf("\n", at);
    const line = text.slice(at, newline < 0 ? text.length : newline);
    scanLine(line.endsWith("\r") ? line.slice(0, -1) : line, at);
    at = newline < 0 ? text.length + 1 : newline + 1;
  }
  closeItem();
  popSections(() => false);
}

/**
 * The body prefix claims are read from: git_pr and git_commit bodies stop before the adapter footer and truncation
 * marker (parseBrainGitFooter's message is always a prefix of the body).
 */
export function claimSourceText(document: Pick<BrainClaimSourceDocument, "provenance" | "body">): string {
  if (!(BRAIN_CLAIM_FOOTER_PROVENANCES as readonly string[]).includes(document.provenance)) return document.body;
  return parseBrainGitFooter(document.body)?.message ?? document.body;
}

/** Deterministic; never throws on any string input. Ordered by span then id, at most maxClaims (cap 50). */
export function extractRulesClaims(
  document: BrainClaimSourceDocument, maxClaims = BRAIN_CLAIMS_PER_DOCUMENT_MAX,
): BrainClaimExtraction {
  const text = claimSourceText(document);
  const drafts: BrainClaimDraft[] = [];
  let overflow = 0;
  scanClaims(text, (draft) => {
    if (drafts.length < DRAFTS_MAX) drafts.push(draft);
    else overflow += 1;
  });
  const finalized = finalizeBrainClaims({ documentId: document.documentId, text, drafts, maxClaims });
  return { ...finalized, claimsRejected: finalized.claimsRejected + overflow };
}
