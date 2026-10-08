/**
 * Person merge suggestions: pairs of person entities (each the root of its merged aliases) that are likely the same
 * human, scored from the scope's person entities, split alias rows and the name and email pairs of live documents.
 * Read only and never merges; accepting one is POST entities/:entityId/aliases with the suggestion's aliasKey. A split
 * between two entities is never suggested again.
 */
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod/v4";
import { BrainApiError } from "../api/types.js";
import {
  BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_MERGE_SUGGESTION_PAGE, type BrainEntityRefView, type BrainMergeEvidenceView,
  type BrainMergeSignal, type BrainMergeSuggestionsQuery, type BrainMergeSuggestionsView, type BrainMergeSuggestionView,
} from "../contracts.js";
import type { BrainScopeKey } from "../types.js";
import { brainEntityId, cutText, personDisplay, queryFingerprint } from "./ids.js";
import type { BrainGraphExecutor } from "./types.js";

export const BRAIN_MERGE_SUGGESTION_LIMITS = {
  ...BRAIN_MERGE_SUGGESTION_PAGE,
  /** Person entities, split rows and name and email pairs read per call; past these the answer is truncated. */
  personsScanned: 5_000, splitsScanned: 5_000, pairsScanned: 5_000,
  /** Suggestions ranked per call, highest score first; past this the answer is truncated. */
  suggestionsMax: 500,
  evidencePerSuggestion: 8,
  /** A name or login shared by more entities than this is too common to suggest from. */
  entitiesPerName: 4,
} as const;

export type {
  BrainMergeEvidenceView, BrainMergeSignal, BrainMergeSuggestionsQuery, BrainMergeSuggestionsView,
  BrainMergeSuggestionView,
};

export const MergeSuggestionsQuerySchema = z.object({
  limit: z.number().int().min(1).max(BRAIN_MERGE_SUGGESTION_LIMITS.pageMax)
    .default(BRAIN_MERGE_SUGGESTION_LIMITS.pageDefault),
  cursor: z.string().min(1).max(BRAIN_FEATURE_CURSOR_MAX_CHARS).optional(),
}).strict();

// Pure scoring.

/** root: the entity it is merged into, else its own id. */
export interface BrainMergePerson {
  readonly entityId: string; readonly key: string; readonly displayName: string; readonly root: string;
}

export interface BrainMergeInput {
  readonly persons: readonly BrainMergePerson[];
  readonly splits: readonly { readonly aliasId: string; readonly entityId: string }[];
  /** n: a `name:` key, e: an `email:` key, documents: live documents whose trailers paired them. */
  readonly pairs: readonly { readonly n: string; readonly e: string; readonly documents: number }[];
}

/** Two roots (a < b by id) and the evidence that they are one person; score in 0.5..0.99. */
export interface BrainMergeCandidate {
  readonly a: BrainMergePerson; readonly b: BrainMergePerson; readonly score: number;
  readonly evidence: readonly BrainMergeEvidenceView[];
}

const WEIGHTS = { same_github_login: 0.95, name_matches_login: 0.8, name_matches_email: 0.7 } as const;
const GITHUB_NOREPLY = /^(?:[0-9]{1,12}\+)?([a-z0-9][a-z0-9-]{0,38}(?:\[bot\])?)@users\.noreply\.github\.com$/;
/** Local parts shared by unrelated people or bots; never matched to a name. */
const SHARED_LOCAL_PARTS = new Set([
  "noreply", "support", "info", "admin", "hello", "contact", "team", "git", "github", "bot", "dev", "root", "mail",
  "notifications", "security", "help", "sales", "user", "test", "office",
]);
const MIN_COMPACT_CHARS = 3;

/** Lowercase letters and digits only: "Hamed MP" and "hamed-mp" both read "hamedmp". */
export function compactName(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** The GitHub login of a noreply email or a `github:` key, else the compact local part of another email. */
function handleOf(key: string): { readonly login: string } | { readonly local: string } | null {
  if (key.startsWith("github:")) return { login: key.slice("github:".length).toLowerCase() };
  if (!key.startsWith("email:")) return null;
  const address = key.slice("email:".length);
  const login = GITHUB_NOREPLY.exec(address)?.[1];
  if (login !== undefined) return { login };
  const local = compactName(address.slice(0, address.lastIndexOf("@")));
  return SHARED_LOCAL_PARTS.has(local) || local.length < MIN_COMPACT_CHARS ? null : { local };
}

/** The names a person goes by: a `name:` key's text and a display name other than its key. */
function namesOf(person: BrainMergePerson): string[] {
  const names = person.key.startsWith("name:") ? [personDisplay(person.key)] : [];
  if (person.displayName !== personDisplay(person.key)) names.push(person.displayName);
  return names;
}

/** A multi-word name is better evidence than a single word ("nima naderi" against "codex"). */
const sharedNameWeight = (multiWord: boolean): number => (multiWord ? 0.7 : 0.5);
const MULTI_WORD = /\S\s+\S/u;

interface Found {
  readonly a: string; readonly b: string;
  readonly evidence: Map<string, BrainMergeEvidenceView & { readonly weight: number }>;
}

/** Entities by compact name or handle; label: the first spelling seen; words: whether any spelling had a space. */
class Groups {
  readonly byKey = new Map<string, { label: string; words: boolean; ids: Set<string> }>();
  add(key: string, label: string, entityId: string): void {
    const group = this.byKey.get(key) ?? { label, words: false, ids: new Set<string>() };
    group.words ||= MULTI_WORD.test(label);
    group.ids.add(entityId);
    this.byKey.set(key, group);
  }
}

/** Every unordered pair of up to entitiesPerName ids; a larger group is too common and yields none. */
function eachPair(ids: readonly string[], fn: (x: string, y: string) => void): void {
  if (ids.length > BRAIN_MERGE_SUGGESTION_LIMITS.entitiesPerName) return;
  for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) fn(ids[i]!, ids[j]!);
}

/** Scores every pair of roots with evidence; roots split apart by the owner are left out. */
export function findMergeCandidates(input: BrainMergeInput): BrainMergeCandidate[] {
  const byId = new Map(input.persons.map((person) => [person.entityId, person]));
  const clusterOf = (entityId: string): string | undefined => {
    const person = byId.get(entityId);
    return person !== undefined && byId.has(person.root) ? person.root : undefined;
  };
  const pairKey = (x: string, y: string) => (x < y ? `${x} ${y}` : `${y} ${x}`);
  const blocked = new Set<string>();
  for (const split of input.splits) {
    const x = clusterOf(split.aliasId);
    const y = clusterOf(split.entityId);
    if (x !== undefined && y !== undefined) blocked.add(pairKey(x, y));
  }
  const found = new Map<string, Found>();
  const add = (x: string, y: string, signal: BrainMergeSignal, detail: string, weight: number, documents: number | null) => {
    const a = clusterOf(x);
    const b = clusterOf(y);
    if (a === undefined || b === undefined || a === b || blocked.has(pairKey(a, b))) return;
    const key = pairKey(a, b);
    const entry = found.get(key) ?? { a: a < b ? a : b, b: a < b ? b : a, evidence: new Map() };
    found.set(key, entry);
    const evidenceKey = `${signal}\n${compactName(detail)}`;
    const previous = entry.evidence.get(evidenceKey);
    if (previous === undefined || previous.weight < weight) {
      entry.evidence.set(evidenceKey, { signal, detail: cutText(detail, 200), documents, weight });
    }
  };

  // Logins by exact login ("john-smith" and "johnsmith" are two accounts); compactLogins only matches names to them.
  const logins = new Groups();
  const compactLogins = new Map<string, Set<string>>();
  const locals = new Groups();
  const names = new Groups();
  for (const person of input.persons) {
    const handle = handleOf(person.key);
    if (handle !== null && "login" in handle) {
      logins.add(handle.login, handle.login, person.entityId);
      const compact = compactName(handle.login);
      compactLogins.set(compact, (compactLogins.get(compact) ?? new Set<string>()).add(handle.login));
    }
    if (handle !== null && "local" in handle) locals.add(handle.local, handle.local, person.entityId);
    for (const name of namesOf(person)) {
      const compact = compactName(name);
      if (compact.length >= MIN_COMPACT_CHARS) names.add(compact, name, person.entityId);
    }
  }
  for (const group of logins.byKey.values()) {
    eachPair([...group.ids], (x, y) => add(x, y, "same_github_login", group.label, WEIGHTS.same_github_login, null));
  }
  const { entitiesPerName } = BRAIN_MERGE_SUGGESTION_LIMITS;
  for (const [compact, group] of names.byKey) {
    const ids = [...group.ids];
    eachPair(ids, (x, y) => add(x, y, "shared_name", group.label, sharedNameWeight(group.words), null));
    if (ids.length > entitiesPerName) continue; // A common name matches no login or email either.
    const local = locals.byKey.get(compact);
    const handles = [
      ["name_matches_login", [...compactLogins.get(compact) ?? []].map((login) => logins.byKey.get(login)!)],
      ["name_matches_email", local === undefined ? [] : [local]],
    ] as const;
    for (const [signal, matches] of handles) {
      if (matches.reduce((sum, match) => sum + match.ids.size, 0) > entitiesPerName) continue;
      for (const match of matches) {
        for (const x of ids) for (const y of match.ids) add(x, y, signal, match.label, WEIGHTS[signal], null);
      }
    }
  }

  // Trailer pairs: a name seen with several emails was never merged automatically; its share of documents decides.
  const byName = new Map<string, { total: number; emails: { e: string; documents: number }[] }>();
  for (const pair of input.pairs) {
    const entry = byName.get(pair.n) ?? { total: 0, emails: [] };
    entry.total += pair.documents;
    entry.emails.push({ e: pair.e, documents: pair.documents });
    byName.set(pair.n, entry);
  }
  for (const [nameKey, entry] of byName) {
    const name = personDisplay(nameKey);
    const nameId = brainEntityId("person", nameKey);
    for (const email of entry.emails) {
      const weight = 0.5 + 0.4 * (email.documents / entry.total);
      add(nameId, brainEntityId("person", email.e), "name_seen_with_email", name, weight, email.documents);
    }
    eachPair(entry.emails.map((email) => brainEntityId("person", email.e)),
      (x, y) => add(x, y, "shared_name", name, sharedNameWeight(MULTI_WORD.test(name)), entry.total));
  }

  return [...found.values()].map((entry) => {
    const evidence = [...entry.evidence.values()].sort((x, y) => y.weight - x.weight
      || x.signal.localeCompare(y.signal) || x.detail.localeCompare(y.detail));
    const miss = evidence.reduce((product, item) => product * (1 - item.weight), 1);
    return {
      a: byId.get(entry.a)!, b: byId.get(entry.b)!, score: Math.min(0.99, Math.round((1 - miss) * 100) / 100),
      evidence: evidence.slice(0, BRAIN_MERGE_SUGGESTION_LIMITS.evidencePerSuggestion)
        .map(({ signal, detail, documents }) => ({ signal, detail, documents })),
    };
  });
}

/** Email keys are the identity, then GitHub logins, then names (other handles carry no signal). */
function kindRank(key: string): number {
  return key.startsWith("email:") ? 0 : key.startsWith("github:") ? 1 : 2;
}

/** The entity that stays (an email first, then a GitHub login, then more links, then a) and the one merged in. */
export function orientCandidate(
  candidate: Pick<BrainMergeCandidate, "a" | "b">, linksOf: (root: string) => number,
): { readonly entity: BrainMergePerson; readonly alias: BrainMergePerson } {
  const { a, b } = candidate;
  const aStays = kindRank(a.key) - kindRank(b.key) || linksOf(b.entityId) - linksOf(a.entityId);
  return aStays <= 0 ? { entity: a, alias: b } : { entity: b, alias: a };
}
