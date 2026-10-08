/**
 * The Matrix agent's Company Brain read tools (brain_search ... brain_impact): binds the gateway owner once, at
 * registration, passes each call to its feature service and maps every failure to one of the fixed statuses the
 * kernel tools show. brain_why keeps its own adapter in api/agent-tools.ts.
 */
import { z } from "zod/v4";
import { BrainApiError } from "../api/types.js";
import {
  BRAIN_AGENT_TOOL_LIMITS, BrainFeatureError, type BrainAgentReadTools, type BrainAgentReadToolsDeps,
  type BrainAgentResult, type BrainAgentToolName,
} from "../contracts.js";
import { BrainStoreError } from "../index.js";

type BrainFailureStatus = Exclude<BrainAgentResult<object>, { readonly status: "ok" }>;

const NOT_FOUND_CODES: ReadonlySet<string> = new Set(["project_not_found", "entity_not_found", "git_ref_not_found"]);
const NOT_CONFIGURED_CODES: ReadonlySet<string> = new Set(["vector_search_unavailable", "summary_not_configured"]);

/** The fixed status of a failed call; only the error name is logged, never its message. */
export function brainAgentFailureStatus(tool: BrainAgentToolName, error: unknown): BrainFailureStatus {
  if (error instanceof BrainApiError || error instanceof BrainFeatureError) {
    if (NOT_FOUND_CODES.has(error.code)) return { status: "not_found" };
    if (error.code === "invalid_request") return { status: "invalid" };
    if (NOT_CONFIGURED_CODES.has(error.code)) return { status: "not_configured" };
  }
  if (error instanceof BrainStoreError && error.code === "invalid") return { status: "invalid" };
  if (error instanceof z.ZodError) return { status: "invalid" };
  console.error(`[brain-agent] ${tool} failed:`, error instanceof Error ? error.name : typeof error);
  return { status: "unavailable" };
}

/** The item limit of one call: the tool default when absent, never above the tool maximum. */
function limitOf(limit: number | undefined, bounds: { readonly default: number; readonly max: number }): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return bounds.default;
  return Math.min(limit, bounds.max);
}

function bind<TInput, TView extends object>(
  tool: BrainAgentToolName,
  run: (input: TInput) => Promise<TView>,
): (input: TInput) => Promise<BrainAgentResult<TView>> {
  return async (input) => {
    try {
      return { ...(await run(input)), status: "ok" };
    } catch (error: unknown) {
      return brainAgentFailureStatus(tool, error);
    }
  };
}

/** Undefined (no tool registered) without an owner or without any service; a method exists only with its service. */
export function createBrainAgentReadTools(deps: BrainAgentReadToolsDeps): BrainAgentReadTools | undefined {
  const { ownerId, project, search, graph, brief, impact } = deps;
  if (!ownerId || (!project && !search && !graph && !brief && !impact)) return undefined;
  const limits = BRAIN_AGENT_TOOL_LIMITS;
  return {
    ...(search ? {
      search: bind("brain_search", (input) => search.search(ownerId, input.project, {
        q: input.query, mode: "auto", limit: limitOf(input.limit, limits.search),
        ...(input.kinds ? { kinds: input.kinds } : {}), ...(input.claimKinds ? { claimKinds: input.claimKinds } : {}),
        ...(input.path ? { path: input.path } : {}), ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}), ...(input.cursor ? { cursor: input.cursor } : {}),
      })),
    } : {}),
    ...(graph ? {
      timeline: bind("brain_timeline", (input) => graph.timeline(ownerId, input.project, {
        entity: input.entity, limit: limitOf(input.limit, limits.timeline),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      })),
    } : {}),
    ...(project ? {
      claims: bind("brain_claims", (input) => project.listClaims(ownerId, input.project, {
        limit: limitOf(input.limit, limits.claims),
        ...(input.kind ? { kind: input.kind } : {}), ...(input.path ? { path: input.path } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      })),
    } : {}),
    ...(brief ? {
      brief: bind("brain_brief", (input) => brief.getBrief(ownerId, input.project, {
        ...(input.date ? { date: input.date } : {}), ...(input.window ? { window: input.window } : {}),
      })),
      conflicts: bind("brain_conflicts", (input) => brief.conflicts(ownerId, input.project, {
        limit: limitOf(input.limit, limits.conflicts), ...(input.cursor ? { cursor: input.cursor } : {}),
      })),
    } : {}),
    ...(impact ? {
      impact: bind("brain_impact", (input) => impact.impact(ownerId, input.project, {
        head: input.head, ...(input.base ? { base: input.base } : {}), ...(input.depth ? { depth: input.depth } : {}),
      })),
    } : {}),
  };
}
