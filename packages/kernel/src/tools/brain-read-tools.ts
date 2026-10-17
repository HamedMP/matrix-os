/**
 * Company Brain read tools for the Matrix agent: brain_search, brain_timeline, brain_claims, brain_brief,
 * brain_conflicts and brain_impact (brain_why lives in brain-why.ts). Each is a thin read-only adapter over the
 * owner-bound BrainAgentReadTools the gateway passes in; only the tools whose method exists are defined.
 */
import { z } from "zod/v4";
import { BRAIN_BRIEF_DESCRIPTION, BRAIN_BRIEF_INPUT_SHAPE, BRAIN_BRIEF_MESSAGES, renderBrainBrief } from "./brain-brief.js";
import { BRAIN_CLAIMS_DESCRIPTION, BRAIN_CLAIMS_INPUT_SHAPE, BRAIN_CLAIMS_MESSAGES, renderBrainClaims } from "./brain-claims.js";
import {
  BRAIN_CONFLICTS_DESCRIPTION, BRAIN_CONFLICTS_INPUT_SHAPE, BRAIN_CONFLICTS_MESSAGES, renderBrainConflicts,
} from "./brain-conflicts.js";
import { BRAIN_IMPACT_DESCRIPTION, BRAIN_IMPACT_INPUT_SHAPE, BRAIN_IMPACT_MESSAGES, renderBrainImpact } from "./brain-impact.js";
import { createBrainReadHandler, type BrainReadMessages, type BrainReadToolResult } from "./brain-read-format.js";
import {
  BRAIN_AGENT_TOOL_LIMITS, type BrainAgentReadTools, type BrainAgentResult, type BrainReadToolName,
} from "./brain-read-types.js";
import { BRAIN_SEARCH_DESCRIPTION, BRAIN_SEARCH_INPUT_SHAPE, BRAIN_SEARCH_MESSAGES, renderBrainSearch } from "./brain-search.js";
import {
  BRAIN_TIMELINE_DESCRIPTION, BRAIN_TIMELINE_INPUT_SHAPE, BRAIN_TIMELINE_MESSAGES, renderBrainTimeline,
} from "./brain-timeline.js";

export * from "./brain-read-types.js";
export type { BrainReadToolResult } from "./brain-read-format.js";

/** Kernel IPC tool names for options.ts allowedTools; brain_why keeps "mcp__matrix-os-ipc__brain_why". */
export const BRAIN_READ_IPC_TOOL_NAMES = [
  "mcp__matrix-os-ipc__brain_search", "mcp__matrix-os-ipc__brain_timeline", "mcp__matrix-os-ipc__brain_claims",
  "mcp__matrix-os-ipc__brain_brief", "mcp__matrix-os-ipc__brain_conflicts", "mcp__matrix-os-ipc__brain_impact",
] as const;

/** One tool for createSdkMcpServer: tool(name, description, inputShape, handler, { annotations: { readOnlyHint } }). */
export interface BrainReadToolDefinition {
  readonly name: BrainReadToolName;
  readonly description: string;
  readonly inputShape: z.ZodRawShape;
  /** Parses its input against inputShape again (strict), so a forged argument never reaches the gateway. */
  readonly handler: (input: unknown) => Promise<BrainReadToolResult>;
}

const INVALID_ARGUMENTS: BrainReadToolResult = {
  content: [{ type: "text", text: "Those arguments are not valid for this Company Brain tool." }],
};

function define<TShape extends z.ZodRawShape, TView>(
  name: BrainReadToolName,
  description: string,
  inputShape: TShape,
  call: (input: z.output<z.ZodObject<TShape>>) => Promise<BrainAgentResult<TView>>,
  render: (view: TView) => { readonly text: string; readonly external: boolean },
  messages: BrainReadMessages,
): BrainReadToolDefinition {
  const schema = z.object(inputShape).strict();
  const handler = createBrainReadHandler({ tool: name, call, render, messages });
  return {
    name, description, inputShape,
    handler: async (input) => {
      const parsed = schema.safeParse(input);
      return parsed.success ? handler(parsed.data) : INVALID_ARGUMENTS;
    },
  };
}

/** The read tools whose method exists on `tools`, in a fixed order. */
export function brainReadToolDefinitions(tools: BrainAgentReadTools): BrainReadToolDefinition[] {
  const definitions: BrainReadToolDefinition[] = [];
  const limits = BRAIN_AGENT_TOOL_LIMITS;
  const { search, timeline, claims, brief, conflicts, impact } = tools;
  if (search) {
    definitions.push(define("brain_search", BRAIN_SEARCH_DESCRIPTION, BRAIN_SEARCH_INPUT_SHAPE,
      (input) => search.call(tools, { ...input, limit: input.limit ?? limits.search.default }), renderBrainSearch,
      BRAIN_SEARCH_MESSAGES));
  }
  if (timeline) {
    definitions.push(define("brain_timeline", BRAIN_TIMELINE_DESCRIPTION, BRAIN_TIMELINE_INPUT_SHAPE,
      (input) => timeline.call(tools, { ...input, limit: input.limit ?? limits.timeline.default }), renderBrainTimeline,
      BRAIN_TIMELINE_MESSAGES));
  }
  if (claims) {
    definitions.push(define("brain_claims", BRAIN_CLAIMS_DESCRIPTION, BRAIN_CLAIMS_INPUT_SHAPE,
      (input) => claims.call(tools, { ...input, limit: input.limit ?? limits.claims.default }), renderBrainClaims,
      BRAIN_CLAIMS_MESSAGES));
  }
  if (brief) {
    definitions.push(define("brain_brief", BRAIN_BRIEF_DESCRIPTION, BRAIN_BRIEF_INPUT_SHAPE,
      (input) => brief.call(tools, input), renderBrainBrief, BRAIN_BRIEF_MESSAGES));
  }
  if (conflicts) {
    definitions.push(define("brain_conflicts", BRAIN_CONFLICTS_DESCRIPTION, BRAIN_CONFLICTS_INPUT_SHAPE,
      (input) => conflicts.call(tools, { ...input, limit: input.limit ?? limits.conflicts.default }),
      renderBrainConflicts, BRAIN_CONFLICTS_MESSAGES));
  }
  if (impact) {
    definitions.push(define("brain_impact", BRAIN_IMPACT_DESCRIPTION, BRAIN_IMPACT_INPUT_SHAPE,
      (input) => impact.call(tools, input), renderBrainImpact, BRAIN_IMPACT_MESSAGES));
  }
  return definitions;
}

/** allowedTools entries for the tools brainReadToolDefinitions(tools) defines. */
export function brainReadIpcToolNames(tools: BrainAgentReadTools | undefined): string[] {
  if (!tools) return [];
  return brainReadToolDefinitions(tools).map((definition) => `mcp__matrix-os-ipc__${definition.name}`);
}
