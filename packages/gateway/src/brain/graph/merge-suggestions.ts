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
