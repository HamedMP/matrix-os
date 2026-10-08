/**
 * Company Brain graph: table shapes and the internal records shared by derive.ts (pure), store.ts (writes), reads and
 * the service. The public views, limits and service interface live in ../contracts/graph.ts.
 */
import type { ColumnType, Kysely, Transaction } from "kysely";
import type { BrainAliasReason, BrainAliasState, BrainEntityKind, BrainLinkMode, BrainLinkType } from "../contracts.js";
import type { BrainDatabase } from "../types.js";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
type JsonValue = ColumnType<unknown, unknown, unknown>;

/** Links stored per document; `changed` is read from path refs instead. */
export type BrainStoredLinkType = Exclude<BrainLinkType, "changed">;
export const BRAIN_GRAPH_STORED_LINK_TYPES: readonly BrainStoredLinkType[] = [
  "authored", "reviewed", "mentions", "implements_spec", "references_issue", "decided_in", "describes", "part_of",
];

/** Name and email pairs seen in one document (trailers); at most this many per document. */
export const BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT = 32;
/** Folder entities one document may add (ancestors of its path refs). */
export const BRAIN_GRAPH_FOLDERS_PER_DOCUMENT = 400;
/** Text mentions and decided_in links per document, each. */
export const BRAIN_GRAPH_TEXT_LINKS_MAX = 16;
/** Orphan entities removed per refresh call. */
export const BRAIN_GRAPH_ORPHAN_SWEEP_MAX = 1_000;
export const BRAIN_GRAPH_LINK_COUNT_CAP = 10_000;
export const BRAIN_GRAPH_LOCK_PREFIX = "brain-graph:";
export const BRAIN_GRAPH_LINK_ID_PATTERN = /^lnk_[a-f0-9]{32}$/;

export interface BrainGraphStateTable {
  owner_id: string; scope_id: string; document_id: string; incarnation: string; revision: number;
  claims_digest: string; identities: JsonValue; link_count: number; derived_at: Timestamp; refs_digest: string;
  decision_paths: JsonValue;
}

export interface BrainGraphEntitiesTable {
  owner_id: string; scope_id: string; entity_id: string; kind: BrainEntityKind; key: string; display_name: string;
  document_id: string | null; first_seen_at: Timestamp; last_seen_at: Timestamp;
}

export interface BrainGraphLinksTable {
  owner_id: string; scope_id: string; link_id: string; document_id: string; type: BrainStoredLinkType;
  mode: BrainLinkMode; from_entity_id: string; to_entity_id: string; ref_kind: string | null; quote: string | null;
  at: Timestamp;
}

/** entity_id: the root the alias resolves to; via_entity_id: the entity it was merged into, when not the root. */
export interface BrainGraphAliasesTable {
  owner_id: string; scope_id: string; alias_entity_id: string; alias_key: string; entity_id: string;
  via_entity_id: string | null; reason: BrainAliasReason; state: BrainAliasState; created_at: Timestamp;
  updated_at: Timestamp;
}

/** A type alias (not an interface) so Kysely's withTables accepts it. */
export type BrainGraphTables = {
  brain_graph_state: BrainGraphStateTable; brain_graph_entities: BrainGraphEntitiesTable;
  brain_graph_links: BrainGraphLinksTable; brain_graph_aliases: BrainGraphAliasesTable;
};

export type BrainGraphDatabase = BrainDatabase & BrainGraphTables;
export type BrainGraphExecutor = Kysely<BrainGraphDatabase> | Transaction<BrainGraphDatabase>;

/** An entity before its id: key per BRAIN_ENTITY_KINDS rules, display name cut to 200 characters. */
export interface BrainEntityDraft { readonly kind: BrainEntityKind; readonly key: string; readonly displayName: string }

export interface BrainLinkDraft {
  readonly type: BrainStoredLinkType; readonly mode: BrainLinkMode; readonly from: BrainEntityDraft;
  readonly to: BrainEntityDraft; readonly refKind: string | null; readonly quote: string | null;
}

/** n: a `name:` person key, e: the `email:` key seen with it. */
export interface BrainIdentityPair { readonly n: string; readonly e: string }

/** Everything derive.ts reads: the live document, its refs, its current decision quotes and two lookups. */
export interface BrainGraphDocumentInput {
  readonly documentId: string; readonly provenance: string; readonly title: string; readonly body: string;
  readonly refs: readonly { readonly kind: string; readonly value: string }[];
  readonly decisionQuotes: readonly string[];
  /** Paths quoted in decisionQuotes that are path refs of the scope; only these become decided_in file links. */
  readonly knownPaths?: ReadonlySet<string>;
  /** Entities the parent document (its `parent` ref) describes: pull requests and issues. */
  readonly parentTargets: readonly BrainEntityDraft[];
  /** Pull request numbers whose github_pr documents carry this git_commit's sha as a `commit` ref. */
  readonly commitPullRequests: readonly string[];
}

export interface BrainGraphDerivation {
  readonly entities: readonly BrainEntityDraft[]; readonly links: readonly BrainLinkDraft[];
  readonly identities: readonly BrainIdentityPair[];
}
