/**
 * Structural mirror of the gateway's Company Brain agent contract (brain/contracts/agent.ts and the views its
 * formatters read). The kernel cannot import the gateway, so the names, fields and unions are repeated here; the
 * gateway's createBrainAgentReadTools result must stay assignable to BrainAgentReadTools below.
 */

export const BRAIN_CITE_KINDS = [
  "pr", "commit", "spec", "review", "comment", "issue", "note", "file", "chat", "doc", "event", "update", "thread",
  "document",
] as const;
export type BrainCiteKind = (typeof BRAIN_CITE_KINDS)[number];
export const BRAIN_CLAIM_KINDS = ["invariant", "decision", "commitment", "risk"] as const;
export type BrainClaimKind = (typeof BRAIN_CLAIM_KINDS)[number];
export type BrainBriefWindow = "day" | "week";

// Inputs. `project` is a project id or slug; the owner is bound by the gateway.

export interface BrainAgentSearchInput {
  readonly project: string; readonly query: string; readonly kinds?: readonly BrainCiteKind[];
  readonly claimKinds?: readonly BrainClaimKind[]; readonly path?: string; readonly from?: string;
  readonly to?: string; readonly limit?: number; readonly cursor?: string;
}
export interface BrainAgentTimelineInput {
  readonly project: string; readonly entity: string; readonly limit?: number; readonly cursor?: string;
}
export interface BrainAgentClaimsInput {
  readonly project: string; readonly kind?: BrainClaimKind; readonly path?: string; readonly limit?: number;
  readonly cursor?: string;
}
export interface BrainAgentBriefInput { readonly project: string; readonly date?: string; readonly window?: BrainBriefWindow }
export interface BrainAgentConflictsInput { readonly project: string; readonly limit?: number; readonly cursor?: string }
export interface BrainAgentImpactInput {
  readonly project: string; readonly head: string; readonly base?: string; readonly depth?: 1 | 2;
}

export type BrainAgentResult<TView> =
  | ({ readonly status: "ok" } & TView)
  | { readonly status: "not_found" } | { readonly status: "invalid" } | { readonly status: "not_configured" }
  | { readonly status: "unavailable" };

// Views (only the fields the formatters read).

export interface BrainCiteView {
  readonly documentId: string; readonly kind: BrainCiteKind; readonly label: string; readonly title: string;
  readonly permalink: string; readonly date: string;
}
export interface BrainIndexFreshness {
  readonly caughtUp: boolean; readonly pendingDocuments: number; readonly pendingCapped: boolean;
}

export interface BrainSearchHitView {
  readonly type: "document" | "claim";
  readonly snippet: { readonly text: string; readonly truncatedStart: boolean; readonly truncatedEnd: boolean };
  readonly claim: {
    readonly kind: BrainClaimKind; readonly label: string | null; readonly statement: string; readonly stale: boolean;
  } | null;
  readonly cite: BrainCiteView;
}
export type BrainSearchNotice =
  | "terms_dropped" | "query_empty_after_parse" | "candidates_capped" | "index_behind" | "any_term_fallback";
export interface BrainSearchView {
  readonly q: string; readonly mode: "text" | "hybrid"; readonly items: readonly BrainSearchHitView[];
  readonly nextCursor: string | null; readonly freshness: BrainIndexFreshness;
  readonly notices: readonly BrainSearchNotice[];
}

export type BrainLinkMode = "explicit" | "inferred";
export interface BrainEntityRefView { readonly kind: string; readonly key: string; readonly displayName: string }
export interface BrainTimelineItemView {
  readonly cite: BrainCiteView; readonly linkTypes: readonly string[]; readonly mode: BrainLinkMode;
  readonly matchedPaths: readonly string[];
}
export interface BrainTimelineView {
  readonly entity: BrainEntityRefView; readonly items: readonly BrainTimelineItemView[];
  readonly nextCursor: string | null; readonly freshness: BrainIndexFreshness;
}

export interface BrainClaimDocumentView {
  readonly kind: "pr" | "commit" | "spec" | "document"; readonly label: string; readonly title: string;
  readonly permalink: string; readonly date: string;
}
export interface BrainClaimView {
  readonly kind: BrainClaimKind; readonly label: string | null; readonly statement: string;
  readonly fields: { readonly assignee?: string; readonly due?: string; readonly severity?: "low" | "medium" | "high" };
  readonly stale: boolean; readonly document: BrainClaimDocumentView;
}
export interface BrainClaimsView {
  readonly kind: BrainClaimKind | null; readonly path: string | null; readonly match: "file_or_folder" | "folder" | null;
  readonly items: readonly BrainClaimView[]; readonly nextCursor: string | null;
}

export interface BrainBriefLine {
  readonly text: string; readonly cites: readonly BrainCiteView[]; readonly due: string | null;
  readonly assignee: string | null; readonly severity: "low" | "medium" | "high" | null;
}
export interface BrainBriefChangeGroup {
  readonly label: string; readonly created: number; readonly revised: number; readonly items: readonly BrainBriefLine[];
}
export interface BrainBriefView {
  readonly date: string; readonly window: BrainBriefWindow;
  readonly sections: {
    readonly changes: readonly BrainBriefChangeGroup[]; readonly decisions: readonly BrainBriefLine[];
    readonly commitments: readonly BrainBriefLine[]; readonly risks: readonly BrainBriefLine[];
    readonly attention: readonly BrainBriefLine[];
  };
  readonly summary: { readonly text: string } | null; readonly truncated: boolean;
}

export type BrainConflictRule = "label_disagreement" | "draft_spec_shipped" | "commitment_reversed";
export interface BrainConflictSideView { readonly cite: BrainCiteView; readonly quote: string }
export interface BrainConflictView {
  readonly rule: BrainConflictRule; readonly summary: string;
  readonly sides: readonly [BrainConflictSideView, BrainConflictSideView];
}
export interface BrainConflictsView { readonly items: readonly BrainConflictView[]; readonly nextCursor: string | null }

export type BrainImpactChangeStatus = "added" | "modified" | "deleted" | "renamed" | "type_changed";
export interface BrainImpactClaim {
  readonly kind: "invariant" | "decision"; readonly label: string | null; readonly statement: string;
  readonly paths: readonly string[]; readonly cite: BrainCiteView;
}
export type BrainImpactNotice =
  | "changed_files_capped" | "dependents_capped" | "scan_capped" | "read_budget_exhausted" | "run_budget_exhausted"
  | "no_git_source" | "brain_behind_head";
export interface BrainImpactView {
  readonly base: { readonly ref: string; readonly sha: string };
  readonly head: { readonly ref: string; readonly sha: string };
  readonly changedFiles: readonly {
    readonly path: string; readonly status: BrainImpactChangeStatus; readonly previousPath: string | null;
    readonly isTest: boolean;
  }[];
  readonly changedTotal: number;
  readonly dependents: readonly { readonly path: string; readonly depth: 1 | 2; readonly via: string }[];
  readonly prior: readonly { readonly path: string; readonly items: readonly BrainCiteView[] }[];
  readonly invariants: readonly BrainImpactClaim[]; readonly decisions: readonly BrainImpactClaim[];
  readonly untested: readonly { readonly path: string }[];
  readonly specs: readonly {
    readonly spec: string; readonly changedPaths: readonly string[]; readonly cite: BrainCiteView | null;
  }[];
  readonly notices: readonly BrainImpactNotice[];
}

/** Bound to the gateway owner; a method is present only when its service exists. */
export interface BrainAgentReadTools {
  search?(input: BrainAgentSearchInput): Promise<BrainAgentResult<BrainSearchView>>;
  timeline?(input: BrainAgentTimelineInput): Promise<BrainAgentResult<BrainTimelineView>>;
  claims?(input: BrainAgentClaimsInput): Promise<BrainAgentResult<BrainClaimsView>>;
  brief?(input: BrainAgentBriefInput): Promise<BrainAgentResult<BrainBriefView>>;
  conflicts?(input: BrainAgentConflictsInput): Promise<BrainAgentResult<BrainConflictsView>>;
  impact?(input: BrainAgentImpactInput): Promise<BrainAgentResult<BrainImpactView>>;
}

/** Default and maximum items per answer (smaller than the HTTP maxima). */
export const BRAIN_AGENT_TOOL_LIMITS = {
  search: { default: 8, max: 20 }, timeline: { default: 10, max: 30 }, claims: { default: 10, max: 50 },
  conflicts: { default: 10, max: 20 },
} as const;
/** Characters of one answer before the untrusted-content wrapper. */
export const BRAIN_AGENT_TEXT_MAX_CHARS = {
  brain_search: 8_000, brain_timeline: 8_000, brain_claims: 8_000, brain_brief: 10_000, brain_conflicts: 8_000,
  brain_impact: 12_000,
} as const;
export type BrainReadToolName = keyof typeof BRAIN_AGENT_TEXT_MAX_CHARS;
