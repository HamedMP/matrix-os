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
