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
