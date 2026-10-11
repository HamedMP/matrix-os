/**
 * Graph derivation for one live document: entities and typed links from its provenance, git footer and trailers,
 * refs, text mentions and current decision claims. Pure and deterministic: the same input gives the same output.
 */
import {
  BRAIN_GRAPH_LIMITS, BRAIN_ISSUE_KEY_PATTERN, BRAIN_PERSON_KEY_PATTERN, BRAIN_PR_NUMBER_PATTERN, type BrainLinkMode,
} from "../contracts.js";
import { isIndexablePath } from "../git/index.js";
import { parseBrainGitFooter, type BrainGitFooter } from "../why.js";
import { cutText, entityDraft, isEntityKey, personDisplay, personEmailKey, personNameKey } from "./ids.js";
import {
  BRAIN_GRAPH_FOLDERS_PER_DOCUMENT, BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT, BRAIN_GRAPH_TEXT_LINKS_MAX,
  type BrainEntityDraft, type BrainGraphDerivation, type BrainGraphDocumentInput, type BrainIdentityPair,
  type BrainLinkDraft, type BrainStoredLinkType,
} from "./types.js";

type Refs = ReadonlyMap<string, readonly string[]>;

const GIT_PROVENANCES: ReadonlySet<string> = new Set(["git_pr", "git_commit"]);
const REVIEW_PROVENANCES: ReadonlySet<string> = new Set(["github_review", "github_review_comment"]);
// Linear patterns only: trailer lines are not whitespace-collapsed and a message can be 64 KB.
const TRAILER = /^\s*(co-authored-by|signed-off-by|reviewed-by):[ \t]*(\S.*)$/i;
const HASH_NUMBER = /(?<![\w/&#])#([1-9][0-9]{0,8})\b/g;
const CLOSING_BEFORE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s*$/i;
const SPEC_DIR = /(?<![\w./-])(specs\/[0-9]{3,4}-[a-z0-9][a-z0-9-]{0,100})(?![\w-])/g;
const PATH_TOKEN = /(?<![\w./@-])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,10})(?![\w/])/g;
const TRACKER_KEY = /\b([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8})\b/g;
const PERSON_REF_LINKS: Readonly<Record<string, BrainStoredLinkType>> = {
  author: "authored", reviewer: "reviewed", assignee: "mentions", attendee: "mentions", participant: "mentions",
};

/** One described entity: what a record document (PR, issue, spec) is the record of. */
export interface BrainDescribed {
  readonly entity: BrainEntityDraft; readonly mode: BrainLinkMode; readonly refKind: string | null;
}

class Collector {
  readonly links: BrainLinkDraft[] = [];
  readonly entities = new Map<string, BrainEntityDraft>();
  private readonly seen = new Set<string>();

  /** Drafts whose key the entities table would refuse (kind rules, 512 bytes) are dropped, never written. */
  entity(draft: BrainEntityDraft): void {
    const key = `${draft.kind}:${draft.key}`;
    if (!this.entities.has(key) && isEntityKey(draft.kind, draft.key)) this.entities.set(key, draft);
  }

  add(
    type: BrainStoredLinkType, mode: BrainLinkMode, from: BrainEntityDraft, to: BrainEntityDraft,
    refKind: string | null, quote: string | null,
  ): void {
    const key = JSON.stringify([type, from.kind, from.key, to.kind, to.key]);
    if (this.links.length >= BRAIN_GRAPH_LIMITS.linksPerDocument || this.seen.has(key)) return;
    if (!isEntityKey(from.kind, from.key) || !isEntityKey(to.kind, to.key)) return;
    this.seen.add(key);
    const cut = quote === null ? "" : cutText(quote, BRAIN_GRAPH_LIMITS.evidenceQuoteMaxChars);
    this.links.push({ type, mode, from, to, refKind, quote: cut === "" ? null : cut });
    this.entity(from);
    this.entity(to);
  }
}

function groupRefs(refs: BrainGraphDocumentInput["refs"]): Refs {
  const grouped = new Map<string, string[]>();
  for (const ref of refs) grouped.set(ref.kind, [...(grouped.get(ref.kind) ?? []), ref.value]);
  return grouped;
}

const pullRequest = (number: string): BrainEntityDraft => entityDraft("pull_request", number, `#${number}`);
const issue = (key: string): BrainEntityDraft => entityDraft("issue", key, key);
const spec = (dir: string): BrainEntityDraft => entityDraft("spec", dir, dir);

/** The entities a document is the record of (git_pr / github_pr, github_issue / linear_issue, git_spec). */
export function describedEntities(
  provenance: string, footer: BrainGitFooter | null, refs: Refs,
): readonly BrainDescribed[] {
  const first = (kind: string, pattern: RegExp) => (refs.get(kind) ?? []).find((value) => pattern.test(value));
  if (provenance === "git_pr" && footer !== null && footer.number !== null) {
    const mode = footer.mergedBranch || footer.sigil === "!" ? "explicit" : "inferred";
    return [{ entity: pullRequest(String(footer.number)), mode, refKind: null }];
  }
  const number = provenance === "github_pr" ? first("pr", BRAIN_PR_NUMBER_PATTERN) : undefined;
  if (number !== undefined) return [{ entity: pullRequest(number), mode: "explicit", refKind: "pr" }];
  const key = provenance === "github_issue" || provenance === "linear_issue"
    ? first("handle", BRAIN_ISSUE_KEY_PATTERN) : undefined;
  if (key !== undefined) return [{ entity: issue(key), mode: "explicit", refKind: "handle" }];
  if (provenance !== "git_spec") return [];
  return (refs.get("spec") ?? []).filter(isIndexablePath)
    .map((dir) => ({ entity: spec(dir), mode: "explicit" as const, refKind: "spec" }));
}

/** The git footer of git_pr and git_commit bodies, else null. */
export function graphFooter(provenance: string, body: string): BrainGitFooter | null {
  return GIT_PROVENANCES.has(provenance) ? parseBrainGitFooter(body) : null;
}

export function describedFor(
  provenance: string, body: string, refs: BrainGraphDocumentInput["refs"],
): readonly BrainDescribed[] {
  return describedEntities(provenance, graphFooter(provenance, body), groupRefs(refs));
}

/** The `Author:` line between the footer's `Commit:` line and the end of the body. */
function footerAuthor(body: string): string | null {
  const lines = body.split("\n");
  for (let index = lines.length - 1; index >= 0 && !lines[index]!.startsWith("Commit: "); index -= 1) {
    if (lines[index]!.startsWith("Author: ")) return lines[index]!.slice("Author: ".length);
  }
  return null;
}

/** `Name <email>` split at the last `<` with string scans; email null when the value does not end in one. */
function nameAndEmail(value: string): { readonly name: string; readonly email: string | null } {
  const open = value.lastIndexOf("<");
  const email = open === -1 || !value.endsWith(">") ? "" : value.slice(open + 1, -1);
  return email.slice(1, -1).includes("@") && !/[\s<>]/.test(email)
    ? { name: value.slice(0, open).trimEnd(), email } : { name: value, email: null };
}

function personLinks(
  out: Collector, doc: BrainEntityDraft, body: string, footer: BrainGitFooter | null, refs: Refs,
): BrainIdentityPair[] {
  const identities = new Map<string, BrainIdentityPair>();
  const author = footer === null ? null : footerAuthor(body);
  const authorKey = author === null || author === "unknown" ? null : personNameKey(author);
  if (authorKey !== null) {
    out.add("authored", "explicit", entityDraft("person", authorKey, author!), doc, null, `Author: ${author}`);
  }
  let trailers = 0;
  for (const line of footer === null ? [] : footer.message.split("\n")) {
    const trailer = trailers < BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT ? TRAILER.exec(line.trimEnd()) : null;
    if (trailer === null) continue;
    trailers += 1;
    const { name, email } = nameAndEmail(trailer[2]!);
    const nameKey = personNameKey(name);
    const emailKey = email === null ? null : personEmailKey(email);
    const key = emailKey ?? nameKey;
    if (key === null) continue;
    if (emailKey !== null && nameKey !== null) identities.set(`${nameKey}\n${emailKey}`, { n: nameKey, e: emailKey });
    const type = trailer[1]!.toLowerCase() === "reviewed-by" ? "reviewed" : "authored";
    out.add(type, "explicit", entityDraft("person", key, name.trim() || personDisplay(key)), doc, null, line.trim());
  }
  for (const [kind, type] of Object.entries(PERSON_REF_LINKS)) {
    for (const key of (refs.get(kind) ?? []).filter((value) => BRAIN_PERSON_KEY_PATTERN.test(value))) {
      const person = entityDraft("person", key, personDisplay(key));
      if (type === "mentions") out.add(type, "explicit", doc, person, kind, null);
      else out.add(type, "explicit", person, doc, kind, null);
    }
  }
  return [...identities.values()];
}

function refLinks(
  out: Collector, doc: BrainEntityDraft, input: BrainGraphDocumentInput, refs: Refs, own: readonly BrainDescribed[],
): void {
  const ownKeys = new Set(own.map((described) => `${described.entity.kind}:${described.entity.key}`));
  for (const dir of input.provenance === "git_spec" ? [] : (refs.get("spec") ?? []).filter(isIndexablePath)) {
    out.add("implements_spec", "explicit", doc, spec(dir), "spec", null);
  }
  for (const key of (refs.get("issue") ?? []).filter((value) => BRAIN_ISSUE_KEY_PATTERN.test(value))) {
    if (!ownKeys.has(`issue:${key}`)) out.add("references_issue", "explicit", doc, issue(key), "issue", null);
  }
  const prMode = GIT_PROVENANCES.has(input.provenance) ? "inferred" : "explicit";
  for (const number of (refs.get("pr") ?? []).filter((value) => BRAIN_PR_NUMBER_PATTERN.test(value))) {
    if (ownKeys.has(`pull_request:${number}`)) continue;
    if (REVIEW_PROVENANCES.has(input.provenance)) out.add("part_of", "explicit", doc, pullRequest(number), "pr", null);
    else out.add("mentions", prMode, doc, pullRequest(number), "pr", null);
  }
  for (const target of input.parentTargets) out.add("part_of", "explicit", doc, target, "parent", null);
  for (const number of input.commitPullRequests) {
    out.add("part_of", "explicit", doc, pullRequest(number), "commit", null);
  }
}

function lineAt(text: string, index: number): string {
  const end = text.indexOf("\n", index);
  return text.slice(text.lastIndexOf("\n", index) + 1, end === -1 ? text.length : end);
}

function textLinks(
  out: Collector, doc: BrainEntityDraft, text: string, hashIsIssue: boolean, refs: Refs,
  own: readonly BrainDescribed[],
): void {
  // Numbers a ref already states (own record, pr, issue such as a `Linked issues: #5` footer) are not text mentions.
  const stated = [...own.map((described) => described.entity.key), ...(refs.get("issue") ?? []),
    ...(refs.get("pr") ?? []), ...(refs.get("spec") ?? [])];
  const skip = new Set(stated.map((key) => key.replace(/^#/, "")));
  let count = 0;
  for (const match of text.matchAll(HASH_NUMBER)) {
    if (count >= BRAIN_GRAPH_TEXT_LINKS_MAX) break;
    if (skip.has(match[1]!)) continue;
    count += 1;
    const quote = lineAt(text, match.index);
    if (hashIsIssue || CLOSING_BEFORE.test(text.slice(Math.max(0, match.index - 24), match.index))) {
      out.add("references_issue", "inferred", doc, issue(`#${match[1]}`), null, quote);
    } else {
      out.add("mentions", "inferred", doc, pullRequest(match[1]!), null, quote);
    }
  }
  count = 0;
  for (const match of text.matchAll(SPEC_DIR)) {
    if (count >= BRAIN_GRAPH_TEXT_LINKS_MAX) break;
    if (skip.has(match[1]!)) continue;
    count += 1;
    out.add("mentions", "inferred", doc, spec(match[1]!), null, lineAt(text, match.index));
  }
}

/** Indexable path tokens quoted in decision quotes (the candidates for decided_in file links). */
export function quotedPaths(quotes: readonly string[]): string[] {
  return [...new Set(quotes.flatMap((quote) => [...quote.matchAll(PATH_TOKEN)].map((match) => match[1]!)))]
    .filter(isIndexablePath);
}

/**
 * Entities a decision quote names: #N, spec directories, the document's own issue keys, and paths that are path refs
 * of the scope (an import path or a partial path quoted in a spec is not a repository file).
 */
function decidedIn(
  out: Collector, doc: BrainEntityDraft, quotes: readonly string[], hashIsIssue: boolean,
  issueKeys: ReadonlySet<string>, knownPaths: ReadonlySet<string>,
): void {
  let count = 0;
  const add = (entity: BrainEntityDraft, quote: string): void => {
    if (count >= BRAIN_GRAPH_TEXT_LINKS_MAX) return;
    count += 1;
    out.add("decided_in", "inferred", entity, doc, null, quote);
  };
  for (const quote of quotes) {
    for (const match of quote.matchAll(HASH_NUMBER)) {
      add(hashIsIssue ? issue(`#${match[1]}`) : pullRequest(match[1]!), quote);
    }
    for (const match of quote.matchAll(SPEC_DIR)) add(spec(match[1]!), quote);
    for (const match of quote.matchAll(TRACKER_KEY)) if (issueKeys.has(match[1]!)) add(issue(match[1]!), quote);
    for (const match of quote.matchAll(PATH_TOKEN)) {
      if (knownPaths.has(match[1]!)) add(entityDraft("file", match[1]!, match[1]!), quote);
    }
  }
}

/** File entities for path refs and folder entities for their ancestors (bounded per document). */
function pathEntities(out: Collector, paths: readonly string[]): void {
  let folders = 0;
  for (const path of paths.filter(isIndexablePath)) {
    out.entity(entityDraft("file", path, path));
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length && folders < BRAIN_GRAPH_FOLDERS_PER_DOCUMENT; depth += 1) {
      const folder = segments.slice(0, depth).join("/");
      if (out.entities.has(`folder:${folder}`)) continue;
      folders += 1;
      out.entity(entityDraft("folder", folder, folder));
    }
  }
}

export function deriveBrainGraph(input: BrainGraphDocumentInput): BrainGraphDerivation {
  const out = new Collector();
  const doc = entityDraft("document", input.documentId, input.title);
  out.entity(doc);
  const refs = groupRefs(input.refs);
  const footer = graphFooter(input.provenance, input.body);
  const own = describedEntities(input.provenance, footer, refs);
  for (const described of own) out.add("describes", described.mode, doc, described.entity, described.refKind, null);
  const identities = personLinks(out, doc, input.body, footer, refs);
  refLinks(out, doc, input, refs, own);
  const hashIsIssue = footer?.sigil === "!";
  textLinks(out, doc, `${input.title}\n${footer?.message ?? input.body}`, hashIsIssue, refs, own);
  const issueKeys = new Set([...(refs.get("issue") ?? []), ...(refs.get("handle") ?? [])]);
  decidedIn(out, doc, input.decisionQuotes, hashIsIssue, issueKeys, input.knownPaths ?? new Set());
  pathEntities(out, refs.get("path") ?? []);
  return { entities: [...out.entities.values()], links: out.links, identities };
}
