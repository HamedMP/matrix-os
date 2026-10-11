/**
 * Company Brain feature contract, part 8: read-only agent tools for the Matrix agent (kernel IPC) and for Claude
 * Code / Codex (integrations-mcp). Each tool is a thin adapter over a feature service; brain_why stays as it is.
 * The kernel cannot import the gateway, so packages/kernel/src/tools/brain-read-tools.ts mirrors the input and
 * result shapes below structurally (the same names, fields and unions). Types and constants only.
 */
import type { BrainClaimsView } from "../api/claims-types.js";
import type { BrainProjectService } from "../api/types.js";
import type { BrainClaimKind } from "../claims/types.js";
import type { BrainBriefService, BrainBriefView, BrainBriefWindow, BrainConflictsView } from "./brief.js";
import type { BrainCiteKind } from "./common.js";
import type { BrainGraphService, BrainTimelineView } from "./graph.js";
import type { BrainImpactService, BrainImpactView } from "./impact.js";
import type { BrainSearchService, BrainSearchView } from "./search.js";

// Names.

export const BRAIN_AGENT_TOOL_NAMES = [
  "brain_why", "brain_search", "brain_timeline", "brain_claims", "brain_brief", "brain_conflicts", "brain_impact",
] as const;
export type BrainAgentToolName = (typeof BRAIN_AGENT_TOOL_NAMES)[number];
/** New kernel IPC tool names (options.ts allowedTools); brain_why keeps "mcp__matrix-os-ipc__brain_why". */
export const BRAIN_READ_IPC_TOOL_NAMES = [
  "mcp__matrix-os-ipc__brain_search", "mcp__matrix-os-ipc__brain_timeline", "mcp__matrix-os-ipc__brain_claims",
  "mcp__matrix-os-ipc__brain_brief", "mcp__matrix-os-ipc__brain_conflicts", "mcp__matrix-os-ipc__brain_impact",
] as const;

// Inputs. `project` is a project id or slug (BRAIN_PROJECT_REF_PATTERN); the owner is bound by the gateway, never
// passed by the model. Every string is bounded as the matching route query.

export interface BrainAgentSearchInput {
  readonly project: string; readonly query: string; readonly kinds?: readonly BrainCiteKind[];
  readonly claimKinds?: readonly BrainClaimKind[]; readonly path?: string; readonly from?: string;
  readonly to?: string; readonly limit?: number; readonly cursor?: string;
}
/** entity: an entity id or ref, e.g. "file:packages/gateway/src/brain/why.ts", "person:email:a@b.co", "pull_request:2078". */
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

/** Tool limits: default and maximum items per answer (smaller than the HTTP maxima to keep answers short). */
export const BRAIN_AGENT_TOOL_LIMITS = {
  search: { default: 8, max: 20 }, timeline: { default: 10, max: 30 }, claims: { default: 10, max: 50 },
  conflicts: { default: 10, max: 20 },
} as const;
/** Characters of one tool answer, before the untrusted-content wrapper; items that would pass it are left out. */
export const BRAIN_AGENT_TEXT_MAX_CHARS: Readonly<Record<Exclude<BrainAgentToolName, "brain_why">, number>> = {
  brain_search: 8_000, brain_timeline: 8_000, brain_claims: 8_000, brain_brief: 10_000, brain_conflicts: 8_000,
  brain_impact: 12_000,
};

// Results.

/**
 * ok carries the HTTP view. not_found: project (or entity) not found. invalid: a bad argument or cursor.
 * not_configured: the feature is off (meaning search forced, summaries). unavailable: anything else; the tool shows
 * one fixed message and logs only the error name.
 */
export type BrainAgentResult<TView> =
  | ({ readonly status: "ok" } & TView)
  | { readonly status: "not_found" } | { readonly status: "invalid" } | { readonly status: "not_configured" }
  | { readonly status: "unavailable" };

/**
 * Bound to the gateway owner at registration (brain/agent/ creates it; the kernel consumes it). A method is present
 * only when its service exists, and the kernel registers only the tools whose method is present.
 */
export interface BrainAgentReadTools {
  search?(input: BrainAgentSearchInput): Promise<BrainAgentResult<BrainSearchView>>;
  timeline?(input: BrainAgentTimelineInput): Promise<BrainAgentResult<BrainTimelineView>>;
  claims?(input: BrainAgentClaimsInput): Promise<BrainAgentResult<BrainClaimsView>>;
  brief?(input: BrainAgentBriefInput): Promise<BrainAgentResult<BrainBriefView>>;
  conflicts?(input: BrainAgentConflictsInput): Promise<BrainAgentResult<BrainConflictsView>>;
  impact?(input: BrainAgentImpactInput): Promise<BrainAgentResult<BrainImpactView>>;
}

/** brain/agent/ createBrainAgentReadTools(deps): undefined without an owner or without any service. */
export interface BrainAgentReadToolsDeps {
  readonly ownerId: string | null;
  readonly project: BrainProjectService | null; readonly search: BrainSearchService | null;
  readonly graph: BrainGraphService | null; readonly brief: BrainBriefService | null;
  readonly impact: BrainImpactService | null;
}

/**
 * Answer format, shared by kernel and MCP tools: a one-line header ("Search "x": 5 of 23 results, best first."),
 * numbered items `N. <Kind> <label> - YYYY-MM-DD - <title>` (ASCII only) with the permalink on the next line and at most one
 * indented excerpt, then a `More: call <tool> with cursor "..."` line. Third-party text: format characters removed,
 * every line break folded to "\n", one-line fields joined with spaces, then the whole answer wrapped with
 * wrapExternalContent(text, { source: "api", from: "Company Brain", includeWarning: true }) exactly as brain_why.
 */
export const BRAIN_AGENT_UNTRUSTED_FROM = "Company Brain";

/**
 * integrations-mcp (packages/integrations-mcp/src/brain-tools.ts): the same six tools over HTTP to the local
 * gateway (GATEWAY_URL, gatewayAuthHeaders(), redirect "error", AbortSignal.timeout(30_000), response bytes capped at
 * BRAIN_MCP_RESPONSE_MAX_BYTES and parsed with a strict schema), formatted like the kernel tools.
 */
export const BRAIN_MCP_RESPONSE_MAX_BYTES = 512 * 1024;
export const BRAIN_MCP_TIMEOUT_MS = 30_000;
