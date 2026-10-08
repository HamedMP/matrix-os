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

// Cursors: base64url JSON {"v":1,"q":<fingerprint>,"s":<score in hundredths>,"n":<links>,"id":<suggestion id>}.

const CURSOR_JSON = /^\{"v":1,"q":"([a-f0-9]{16})","s":([0-9]{1,3}),"n":([0-9]{1,9}),"id":"(sug_[a-f0-9]{32})"\}$/;
const FINGERPRINT = queryFingerprint(["merge_suggestions"]);

interface Position { readonly s: number; readonly n: number; readonly id: string }

function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify({ v: 1, q: FINGERPRINT, ...position }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Position {
  const parts = /^[A-Za-z0-9_-]+$/.test(cursor) ? CURSOR_JSON.exec(Buffer.from(cursor, "base64url").toString("utf8"))
    : null;
  if (parts === null || parts[1] !== FINGERPRINT) throw new BrainApiError("invalid_request");
  return { s: Number(parts[2]), n: Number(parts[3]), id: parts[4]! };
}

/** Sort order: score, then links, both descending, then id ascending. */
function compare(x: Position, y: Position): number {
  return y.s - x.s || y.n - x.n || x.id.localeCompare(y.id);
}

// Reads.

/** The scan and ranking caps; tests pass smaller ones. */
export type BrainMergeScanLimits = {
  readonly [K in "personsScanned" | "splitsScanned" | "pairsScanned" | "suggestionsMax"]: number;
};

async function readInput(db: BrainGraphExecutor, scope: BrainScopeKey, limits: BrainMergeScanLimits) {
  const persons = await db.selectFrom("brain_graph_entities as e")
    .leftJoin("brain_graph_aliases as a", (join) => join.onRef("a.owner_id", "=", "e.owner_id")
      .onRef("a.scope_id", "=", "e.scope_id").onRef("a.alias_entity_id", "=", "e.entity_id")
      .on("a.state", "=", "merged"))
    .select(["e.entity_id", "e.key", "e.display_name", "a.entity_id as root"])
    .where("e.owner_id", "=", scope.ownerId).where("e.scope_id", "=", scope.scopeId).where("e.kind", "=", "person")
    .orderBy("e.last_seen_at", "desc").orderBy("e.entity_id").limit(limits.personsScanned + 1).execute();
  const splits = await db.selectFrom("brain_graph_aliases").select(["alias_entity_id", "entity_id"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("state", "=", "split")
    .orderBy("alias_entity_id").limit(limits.splitsScanned + 1).execute();
  const pairs = await sql<{ n: string; e: string; documents: number }>`
    SELECT pair->>'n' AS n, pair->>'e' AS e, count(*)::int AS documents FROM brain_graph_state s
    JOIN brain_documents d ON d.owner_id = s.owner_id AND d.scope_id = s.scope_id AND d.document_id = s.document_id
    CROSS JOIN LATERAL jsonb_array_elements(s.identities) AS pair
    WHERE s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
    GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT ${limits.pairsScanned + 1}`.execute(db);
  const truncated = persons.length > limits.personsScanned || splits.length > limits.splitsScanned
    || pairs.rows.length > limits.pairsScanned;
  const input: BrainMergeInput = {
    persons: persons.slice(0, limits.personsScanned).map((row) => ({
      entityId: row.entity_id, key: row.key, displayName: row.display_name, root: row.root ?? row.entity_id,
    })),
    splits: splits.slice(0, limits.splitsScanned).map((row) => ({ aliasId: row.alias_entity_id, entityId: row.entity_id })),
    pairs: pairs.rows.slice(0, limits.pairsScanned),
  };
  return { input, truncated };
}

/** Stored links per entity id (persons only author, review or are mentioned). */
async function linkCounts(db: BrainGraphExecutor, scope: BrainScopeKey, ids: readonly string[]) {
  const counts = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return counts;
  const owner = sql`owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}`;
  const result = await sql<{ id: string; n: number }>`SELECT id, count(*)::int AS n FROM (
      SELECT from_entity_id AS id FROM brain_graph_links WHERE ${owner} AND from_entity_id IN (${sql.join(ids)})
      UNION ALL SELECT to_entity_id FROM brain_graph_links WHERE ${owner} AND to_entity_id IN (${sql.join(ids)})
    ) AS l GROUP BY id`.execute(db);
  for (const row of result.rows) counts.set(row.id, Number(row.n));
  return counts;
}

const refView = (person: BrainMergePerson): BrainEntityRefView => ({
  entityId: person.entityId, kind: "person", key: person.key, displayName: person.displayName,
});

export async function listMergeSuggestions(
  db: BrainGraphExecutor, scope: BrainScopeKey, query: z.output<typeof MergeSuggestionsQuerySchema>,
  limits: BrainMergeScanLimits = BRAIN_MERGE_SUGGESTION_LIMITS,
): Promise<BrainMergeSuggestionsView> {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const { input, truncated: scanTruncated } = await readInput(db, scope, limits);
  const candidates = findMergeCandidates(input)
    .sort((x, y) => y.score - x.score || x.a.entityId.localeCompare(y.a.entityId)
      || x.b.entityId.localeCompare(y.b.entityId));
  const ranked = candidates.slice(0, limits.suggestionsMax);
  const members = new Map<string, string[]>();
  for (const person of input.persons) members.set(person.root, [...members.get(person.root) ?? [], person.entityId]);
  const roots = new Set(ranked.flatMap((candidate) => [candidate.a.entityId, candidate.b.entityId]));
  const links = await linkCounts(db, scope, [...roots].flatMap((root) => members.get(root)!));
  const linksOf = (root: string) => members.get(root)!.reduce((sum, id) => sum + links.get(id)!, 0);

  const suggestions = ranked.map((candidate) => {
    const { entity, alias } = orientCandidate(candidate, linksOf);
    const [entityLinks, aliasLinks] = [linksOf(entity.entityId), linksOf(alias.entityId)];
    const suggestionId = `sug_${createHash("sha256")
      .update(JSON.stringify(["brain_merge_suggestion_v1", entity.entityId, alias.entityId]), "utf8")
      .digest("hex").slice(0, 32)}`;
    const view: BrainMergeSuggestionView = {
      suggestionId, score: candidate.score, entity: refView(entity), alias: refView(alias),
      aliasKey: `person:${alias.key}`, evidence: candidate.evidence,
      counts: { entityLinks, aliasLinks, aliasEntities: members.get(alias.entityId)!.length },
    };
    return { view, position: { s: Math.round(candidate.score * 100), n: entityLinks + aliasLinks, id: suggestionId } };
  }).sort((x, y) => compare(x.position, y.position));

  const rest = after === null ? suggestions : suggestions.filter((item) => compare(item.position, after) > 0);
  const page = rest.slice(0, query.limit);
  const last = rest.length > query.limit ? page[page.length - 1]! : null;
  return {
    items: page.map((item) => item.view), nextCursor: last === null ? null : encodeCursor(last.position),
    truncated: scanTruncated || candidates.length > ranked.length,
  };
}
