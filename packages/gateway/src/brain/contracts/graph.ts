/**
 * Company Brain feature contract, part 5: entities, typed links, person aliases, timelines and neighbourhoods,
 * derived deterministically from documents, refs and claims of one project scope. Types and constants only.
 */
import type { BrainRepository } from "../repository.js";
import type { BrainCiteView, BrainProjectResolver } from "./common.js";
import type { BrainDerivedIndex, BrainIndexFreshness, BrainRefreshView } from "./hooks.js";

// Entities.

export const BRAIN_ENTITY_KINDS = [
  "person", "file", "folder", "spec", "pull_request", "issue", "project", "document",
] as const;
export type BrainEntityKind = (typeof BRAIN_ENTITY_KINDS)[number];

/**
 * Entity keys. person: a person key (BRAIN_PERSON_KEY_PATTERN). file: repo-relative path. folder: repo-relative
 * folder without a trailing "/". spec: spec directory. pull_request: decimal PR number of the project repository.
 * issue: issue key (BRAIN_ISSUE_KEY_PATTERN). project: the project id. document: the document id.
 * entityId = "ent_" + the first 32 hex of sha256(JSON.stringify(["brain_entity_v1", kind, key])), so a ref converts
 * to an id without a lookup. An entity ref is `${kind}:${key}` (the kind never contains ":").
 */
export const BRAIN_ENTITY_ID_PATTERN = /^ent_[a-f0-9]{32}$/;
export const BRAIN_ENTITY_ID_VERSION = "brain_entity_v1";
export const BRAIN_ENTITY_KEY_MAX_BYTES = 512;
export const BRAIN_ENTITY_REF_MAX_CHARS = 600;
export const BRAIN_ENTITY_DISPLAY_NAME_MAX_CHARS = 200;

/**
 * Persons come from git footers (`Author: <name>`; git documents carry no email and no committer), git trailers in
 * the message (`Co-authored-by: Name <email>`, `Signed-off-by:`, `Reviewed-by:`), and author / reviewer / assignee /
 * attendee / participant refs of other sources. Merging: every key seen with the same email merges into the
 * `email:` entity; a `name:` key merges into an `email:` entity only when exactly one email was ever seen with that
 * name in the scope; `github:` merges into `email:` only through an explicit alias. Each merge is an alias row.
 */
export type BrainAliasReason = "same_email" | "single_email_for_name" | "manual";
/** merged: the alias resolves to the entity. split: the owner undid it; derivation never re-merges a split key. */
export type BrainAliasState = "merged" | "split";

// Links.

export const BRAIN_LINK_TYPES = [
  "authored", "reviewed", "changed", "mentions", "implements_spec", "references_issue", "decided_in", "describes",
  "part_of",
] as const;
export type BrainLinkType = (typeof BRAIN_LINK_TYPES)[number];

/**
 * Direction and endpoints. authored, reviewed: person -> document. changed: document -> file (read from path refs,
 * never stored). mentions: document -> person | pull_request | issue | spec (text mentions in title or body).
 * implements_spec: document -> spec. references_issue: document -> issue. decided_in: pull_request | spec | issue |
 * file -> document holding a current decision claim whose quote names that entity. describes: document -> the entity
 * it is the record of (git_pr / github_pr -> pull_request, github_issue / linear_issue -> issue, git_spec -> spec).
 * part_of: document -> pull_request | issue (reviews, review comments, comments via `parent` refs; commits of a PR
 * via `commit` refs).
 */
export const BRAIN_LINK_ENDPOINTS: Readonly<Record<BrainLinkType, {
  readonly from: readonly BrainEntityKind[]; readonly to: readonly BrainEntityKind[];
}>> = {
  authored: { from: ["person"], to: ["document"] },
  reviewed: { from: ["person"], to: ["document"] },
  changed: { from: ["document"], to: ["file"] },
  mentions: { from: ["document"], to: ["person", "pull_request", "issue", "spec"] },
  implements_spec: { from: ["document"], to: ["spec"] },
  references_issue: { from: ["document"], to: ["issue"] },
  decided_in: { from: ["pull_request", "spec", "issue", "file"], to: ["document"] },
  describes: { from: ["document"], to: ["pull_request", "issue", "spec"] },
  part_of: { from: ["document"], to: ["pull_request", "issue"] },
};

/**
 * explicit: a structured field says so (a ref of the right kind, a forge merge message, a trailer, a parent id).
 * inferred: text matching or a heuristic (the git adapter's `(#N)` squash subject, a body mention).
 */
export type BrainLinkMode = "explicit" | "inferred";

/** Evidence: the document, the ref kind or quote that produced the link (quote at most 300 UTF-16 units). */
export interface BrainLinkEvidenceView {
  readonly cite: BrainCiteView; readonly refKind: string | null; readonly quote: string | null;
}

// Limits.

export const BRAIN_GRAPH_LIMITS = {
  /** Stored links derived from one document (changed is never stored). */
  linksPerDocument: 300,
  entitiesPerScope: 200_000,
  aliasesPerEntity: 50,
  timelineDefault: 20, timelineMax: 50,
  entitiesDefault: 20, entitiesMax: 50,
  /** Neighbourhood: hops 1..2; at most this many nodes and links in one answer. */
  hopsMax: 2, neighbourhoodNodesMax: 100, neighbourhoodLinksMax: 200, linksPageDefault: 50,
  /** Entity name search (q) characters. */
  entityQueryMaxChars: 200,
  /** Matched paths shown per timeline item (file and folder timelines). */
  matchedPathsMax: 3,
  evidenceQuoteMaxChars: 300,
} as const;
export const BRAIN_GRAPH_ALIAS_BODY_MAX_BYTES = 2_048;

// Views.

export interface BrainEntityRefView {
  readonly entityId: string; readonly kind: BrainEntityKind; readonly key: string; readonly displayName: string;
}

export interface BrainEntityAliasView {
  readonly aliasKey: string; readonly reason: BrainAliasReason; readonly state: BrainAliasState;
  readonly createdAt: string;
}

/** linkCount: stored links touching the entity, capped at 10,000. */
export interface BrainEntityView extends BrainEntityRefView {
  readonly aliases: readonly BrainEntityAliasView[]; readonly firstSeenAt: string; readonly lastSeenAt: string;
  readonly linkCount: number; readonly linkCountCapped: boolean;
}

export interface BrainLinkView {
  readonly linkId: string; readonly type: BrainLinkType; readonly mode: BrainLinkMode;
  readonly from: BrainEntityRefView; readonly to: BrainEntityRefView;
  readonly evidence: BrainLinkEvidenceView; readonly at: string;
}

/** One document touching the entity. linkTypes: how (unique). matchedPaths: file and folder timelines only. */
export interface BrainTimelineItemView {
  readonly cite: BrainCiteView; readonly linkTypes: readonly BrainLinkType[]; readonly mode: BrainLinkMode;
  readonly matchedPaths: readonly string[];
}

/** Newest source_updated_at first, then document id; keyset paged. */
export interface BrainTimelineView {
  readonly entity: BrainEntityRefView; readonly items: readonly BrainTimelineItemView[];
  readonly nextCursor: string | null; readonly freshness: BrainIndexFreshness;
}

export interface BrainEntitiesView {
  readonly items: readonly BrainEntityRefView[]; readonly nextCursor: string | null;
}

/** nodes: unique, center first. truncated: a node or link cap was hit. nextCursor pages the center's direct links. */
export interface BrainNeighbourhoodView {
  readonly center: BrainEntityRefView; readonly hops: 1 | 2; readonly nodes: readonly BrainEntityRefView[];
  readonly links: readonly BrainLinkView[]; readonly truncated: boolean; readonly nextCursor: string | null;
}

// Queries.

/**
 * entity: an entity id or an entity ref (`file:packages/gateway/src/brain/why.ts`, `person:email:a@b.co`,
 * `folder:packages/gateway/src/brain`, `pull_request:2078`, `issue:ENG-42`, `spec:specs/551-company-brain-store`).
 * A merged alias key resolves to its entity. linkTypes: only items reached through these.
 */
export interface BrainTimelineQuery {
  readonly entity: string; readonly linkTypes?: readonly BrainLinkType[];
  readonly from?: string; readonly to?: string; readonly limit?: number; readonly cursor?: string;
}
/** q: case-insensitive prefix of the key or display name. */
export interface BrainEntitiesQuery {
  readonly kind?: BrainEntityKind; readonly q?: string; readonly limit?: number; readonly cursor?: string;
}
export interface BrainLinksQuery {
  readonly hops?: 1 | 2; readonly types?: readonly BrainLinkType[]; readonly direction?: "out" | "in" | "both";
  readonly limit?: number; readonly cursor?: string;
}
/** merge: aliasKey (an entity ref of the same kind) now resolves to the entity. split: undo a merge of aliasKey. */
/**
 * merge: the alias now resolves to the entity. split: "not the same person", kept, so the pair is never merged or
 * suggested again. unmerge: Undo of a manual merge, which leaves nothing behind (the pair can be suggested again).
 */
export interface BrainAliasInput { readonly action: "merge" | "split" | "unmerge"; readonly aliasKey: string }

// Person merge suggestions (graph/merge-suggestions.ts): read only; accepting one is updateAlias with its aliasKey.

export const BRAIN_MERGE_SUGGESTION_PAGE = { pageDefault: 20, pageMax: 50 } as const;

/**
 * same_github_login: two GitHub noreply emails (`12345+login@users.noreply.github.com`, `login@...`) or a `github:`
 * key with the same login. name_matches_login / name_matches_email: a name equals a GitHub login or an email's local
 * part, ignoring case, spaces and punctuation. name_seen_with_email: git trailers paired the name with the email.
 * shared_name: the same name was seen with both (display names or trailer pairs).
 */
export type BrainMergeSignal =
  | "same_github_login" | "name_matches_login" | "name_matches_email" | "name_seen_with_email" | "shared_name";

/** detail: the login, local part or name; documents: how many live documents showed it (trailer pairs only). */
export interface BrainMergeEvidenceView {
  readonly signal: BrainMergeSignal; readonly detail: string; readonly documents: number | null;
}

/**
 * entity: the entity that stays; alias: the entity that would merge into it, with its own merged aliases. score: 0..1.
 * counts: stored links of each side (over its merged aliases) and how many entities would move.
 */
export interface BrainMergeSuggestionView {
  readonly suggestionId: string; readonly score: number;
  readonly entity: BrainEntityRefView; readonly alias: BrainEntityRefView; readonly aliasKey: string;
  readonly evidence: readonly BrainMergeEvidenceView[];
  readonly counts: { readonly entityLinks: number; readonly aliasLinks: number; readonly aliasEntities: number };
}

/** Highest score first, then most links, then suggestion id; truncated: a scan cap was hit. */
export interface BrainMergeSuggestionsView {
  readonly items: readonly BrainMergeSuggestionView[]; readonly nextCursor: string | null;
  readonly truncated: boolean;
}

/** limit: 1..BRAIN_MERGE_SUGGESTION_PAGE.pageMax, default pageDefault. */
export interface BrainMergeSuggestionsQuery { readonly limit?: number; readonly cursor?: string }

// Service.

export interface BrainGraphServiceDeps {
  readonly repository: BrainRepository; readonly resolver: BrainProjectResolver; readonly now?: () => Date;
}

/** Owner-scoped; reads never refresh the graph. */
export interface BrainGraphService {
  timeline(ownerId: string, projectRef: string, query: BrainTimelineQuery): Promise<BrainTimelineView>;
  listEntities(ownerId: string, projectRef: string, query: BrainEntitiesQuery): Promise<BrainEntitiesView>;
  getEntity(ownerId: string, projectRef: string, entityId: string): Promise<BrainEntityView>;
  links(ownerId: string, projectRef: string, entityId: string, query: BrainLinksQuery): Promise<BrainNeighbourhoodView>;
  /** Person entities only; alias_conflict when the alias belongs to another merged entity. */
  updateAlias(ownerId: string, projectRef: string, entityId: string, input: BrainAliasInput): Promise<BrainEntityView>;
  /** Pairs of person entities that are likely one human; never merges and never refreshes. */
  mergeSuggestions(
    ownerId: string, projectRef: string, query: BrainMergeSuggestionsQuery,
  ): Promise<BrainMergeSuggestionsView>;
  refresh(ownerId: string, projectRef: string): Promise<BrainRefreshView>;
}

/** graph/index.ts creates both from one deps object; the index is the hook listener named "graph". */
export interface BrainGraphFeature { readonly service: BrainGraphService; readonly index: BrainDerivedIndex }
