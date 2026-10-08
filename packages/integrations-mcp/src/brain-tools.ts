import { setImmediate as yieldRead } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  BRAIN_CITE_KINDS, BRAIN_CLAIM_KINDS, brainReadToolDefinitions, type BrainAgentReadTools, type BrainAgentResult,
  type BrainBriefView, type BrainClaimsView, type BrainConflictRule, type BrainConflictsView,
  type BrainImpactChangeStatus, type BrainImpactNotice, type BrainImpactView, type BrainReadToolName,
  type BrainSearchNotice, type BrainSearchView, type BrainTimelineView,
} from "../../kernel/dist/tools/brain-read-tools.js";
import { gatewayAuthHeaders, type GatewayFetcher } from "../../kernel/dist/tools/integrations.js";

/**
 * Read-only Company Brain tools for Claude Code and Codex: brain_search, brain_timeline, brain_claims, brain_brief,
 * brain_conflicts and brain_impact over the local gateway's /api/brain routes. The kernel's tool definitions supply
 * the descriptions, input shapes, status messages and answer text, so these answers match the Matrix agent's; this
 * file adds the bounded HTTP call and a bounded parse of each view. The gateway binds the owner from the bearer.
 */

const RESPONSE_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 30_000;
const TOOL_NAMES = [
  "brain_search", "brain_timeline", "brain_claims", "brain_brief", "brain_conflicts", "brain_impact",
] as const satisfies readonly BrainReadToolName[];
type ToolName = (typeof TOOL_NAMES)[number];
type Views = {
  brain_search: BrainSearchView; brain_timeline: BrainTimelineView; brain_claims: BrainClaimsView;
  brain_brief: BrainBriefView; brain_conflicts: BrainConflictsView; brain_impact: BrainImpactView;
};

const INVALID_ARGUMENTS = {
  content: [{ type: "text" as const, text: "Those arguments are not valid for this Company Brain tool." }],
};

// Responses: only the fields the answers read, every string and list bounded; other fields are dropped. Unions are
// the kernel views': an unknown cite kind reads as "document" and an unknown notice is dropped, as the kernel text does.

const str = (max: number) => z.string().max(max);
const items = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max);
const known = <T extends string>(values: readonly T[]) => items(str(64), 16)
  .transform((list) => list.filter((value): value is T => (values as readonly string[]).includes(value)));
const SEARCH_NOTICES = [
  "terms_dropped", "query_empty_after_parse", "candidates_capped", "index_behind", "any_term_fallback",
] as const satisfies readonly BrainSearchNotice[];
const IMPACT_NOTICES = [
  "changed_files_capped", "dependents_capped", "scan_capped", "read_budget_exhausted", "run_budget_exhausted",
  "no_git_source", "brain_behind_head",
] as const satisfies readonly BrainImpactNotice[];
const RULES = ["label_disagreement", "draft_spec_shipped", "commitment_reversed"] as const satisfies
  readonly BrainConflictRule[];
const STATUSES = ["added", "modified", "deleted", "renamed", "type_changed"] as const satisfies
  readonly BrainImpactChangeStatus[];
const SEVERITY = z.enum(["low", "medium", "high"]);
const CITE_FIELDS = { label: str(400), title: str(4_000), permalink: str(2_048), date: str(64) };
const CITE = z.object({ documentId: str(200), kind: z.enum(BRAIN_CITE_KINDS).catch("document"), ...CITE_FIELDS });
const FRESH = z.object({ caughtUp: z.boolean(), pendingDocuments: z.number().int().min(0), pendingCapped: z.boolean() });
const NEXT = { nextCursor: str(1_024).nullable() };
const LINE = z.object({
  text: str(2_000), cites: items(CITE, 8), due: str(32).nullable(), assignee: str(400).nullable(),
  severity: SEVERITY.nullable(),
});
const IMPACT_CLAIM = z.object({
  kind: z.enum(["invariant", "decision"]), label: str(400).nullable(), statement: str(4_000),
  paths: items(str(1_024), 50), cite: CITE,
});
const REF = z.object({ ref: str(400), sha: str(64) });
const SIDE = z.object({ cite: CITE, quote: str(2_000) });
const SCHEMAS: { [N in ToolName]: z.ZodType<Views[N]> } = {
  brain_search: z.object({
    q: str(1_000), mode: z.enum(["text", "hybrid"]), freshness: FRESH, notices: known(SEARCH_NOTICES), ...NEXT,
    items: items(z.object({
      type: z.enum(["document", "claim"]), cite: CITE,
      snippet: z.object({ text: str(4_000), truncatedStart: z.boolean(), truncatedEnd: z.boolean() }),
      claim: z.object({
        kind: z.enum(BRAIN_CLAIM_KINDS), label: str(400).nullable(), statement: str(4_000), stale: z.boolean(),
      }).nullable(),
    }), 100),
  }),
  brain_timeline: z.object({
    entity: z.object({ kind: str(32), key: str(1_024), displayName: str(1_024) }), freshness: FRESH, ...NEXT,
    items: items(z.object({
      cite: CITE, linkTypes: items(str(32), 16), mode: z.enum(["explicit", "inferred"]),
      matchedPaths: items(str(1_024), 10),
    }), 100),
  }),
  brain_claims: z.object({
    kind: z.enum(BRAIN_CLAIM_KINDS).nullable(), path: str(1_024).nullable(),
    match: z.enum(["file_or_folder", "folder"]).nullable(), ...NEXT,
    items: items(z.object({
      kind: z.enum(BRAIN_CLAIM_KINDS), label: str(400).nullable(), statement: str(4_000), stale: z.boolean(),
      document: z.object({ kind: z.enum(["pr", "commit", "spec", "document"]).catch("document"), ...CITE_FIELDS }),
      fields: z.object({ assignee: str(400).optional(), due: str(32).optional(), severity: SEVERITY.optional() }),
    }), 100),
  }),
  brain_brief: z.object({
    date: str(32), window: z.enum(["day", "week"]), truncated: z.boolean(),
    summary: z.object({ text: str(4_000) }).nullable(),
    sections: z.object({
      attention: items(LINE, 100), decisions: items(LINE, 100), commitments: items(LINE, 100), risks: items(LINE, 100),
      changes: items(z.object({
        label: str(400), created: z.number().int(), revised: z.number().int(), items: items(LINE, 100),
      }), 50),
    }),
  }),
  brain_conflicts: z.object({
    ...NEXT, items: items(z.object({ rule: z.enum(RULES), summary: str(2_000), sides: z.tuple([SIDE, SIDE]) }), 100),
  }),
  brain_impact: z.object({
    base: REF, head: REF, changedTotal: z.number().int().min(0), notices: known(IMPACT_NOTICES),
    changedFiles: items(z.object({
      path: str(1_024), status: z.enum(STATUSES), previousPath: str(1_024).nullable(), isTest: z.boolean(),
    }), 500),
    dependents: items(z.object({ path: str(1_024), depth: z.union([z.literal(1), z.literal(2)]), via: str(1_024) }), 300),
    prior: items(z.object({ path: str(1_024), items: items(CITE, 10) }), 50),
    invariants: items(IMPACT_CLAIM, 50), decisions: items(IMPACT_CLAIM, 50),
    untested: items(z.object({ path: str(1_024) }), 100),
    specs: items(z.object({ spec: str(1_024), changedPaths: items(str(1_024), 500), cite: CITE.nullable() }), 20),
  }),
};
