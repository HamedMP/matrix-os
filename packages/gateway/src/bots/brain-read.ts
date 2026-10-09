/**
 * `brain.read` for recipe Bots (spec 567). Runs the kernel's own Company Brain read tools for the run's owner, so a
 * Bot gets the same text, citations and untrusted-content wrapper as the Matrix agent and the MCP tools.
 *
 * - The owner is always the run binding's owner; the model never names one.
 * - A thread's project is fixed: another `project` is refused. The direct Chat must name a project, which each brain
 *   service resolves owner-scoped (a foreign or missing one reads as not found).
 * - `project` and `detail` inside `input` are refused; brain_why always answers in its brief form.
 * - Inputs are parsed again with the brain tool's own strict shape before any service runs.
 */
import { BRAIN_WHY_INPUT_SHAPE, brainReadToolDefinitions, createBrainWhyToolHandler } from "@matrix-os/kernel";
import type { BotBrainReadTool, BotToolRequest, BotToolResult } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { createBrainAgentReadTools } from "../brain/agent/index.js";
import { createBrainAgentTools } from "../brain/api/index.js";
import type { BrainServices } from "../brain/contracts.js";
import { BotBrokerActionError } from "./broker-actions.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";

type BrainReadArgs = Extract<BotToolRequest, { capability: "brain.read" }>["args"];
type ToolText = { content: Array<{ type: "text"; text: string }> };

/** The brain services a Bot reads; impact is never one of them. */
export type BotBrainServices = Pick<BrainServices, "project" | "search" | "graph" | "brief">;
export type BotBrainRead = (binding: BotRuntimeBinding, args: BrainReadArgs) => Promise<BotToolResult>;

const KERNEL_NAMES: Record<Exclude<BotBrainReadTool, "why">, string> = {
  search: "brain_search", timeline: "brain_timeline", claims: "brain_claims", brief: "brain_brief", conflicts: "brain_conflicts",
};
const WhyInputSchema = z.object(BRAIN_WHY_INPUT_SHAPE).strict();
const MAX_TEXT_PART_CHARS = 60 * 1024;

function invalid(): never {
  throw new BotBrokerActionError("invalid_arguments");
}

function toResult(answer: ToolText): BotToolResult {
  const content = answer.content.slice(0, 16).map((part) => ({ type: "text" as const, text: part.text.slice(0, MAX_TEXT_PART_CHARS) }));
  if (content.length === 0) throw new BotBrokerActionError("unavailable");
  return { ok: true, content };
}

export function createBotBrainRead(services: BotBrainServices): BotBrainRead {
  return async (binding, args) => {
    if (Object.hasOwn(args.input, "project") || Object.hasOwn(args.input, "detail")) invalid();
    const bound = binding.brainProjectId;
    if (bound !== undefined && args.project !== undefined && args.project !== bound) invalid();
    const project = bound ?? args.project ?? invalid();
    const tool = args.tool;
    if (tool === "why") {
      const parsed = WhyInputSchema.safeParse({ ...args.input, project, detail: "brief" });
      if (!parsed.success) invalid();
      const tools = createBrainAgentTools(services.project, binding.ownerId);
      if (!tools) throw new BotBrokerActionError("unavailable");
      return toResult(await createBrainWhyToolHandler(tools)(parsed.data));
    }
    const definitions = brainReadToolDefinitions(createBrainAgentReadTools({
      ownerId: binding.ownerId, project: services.project, search: services.search, graph: services.graph,
      brief: services.brief, impact: null,
    }) ?? {});
    const name = KERNEL_NAMES[tool];
    const definition = definitions.find((candidate) => candidate.name === name);
    // A feature whose start failed has no tool: the brain is up but this view is off.
    if (!definition) throw new BotBrokerActionError("unavailable");
    const input = { ...args.input, project };
    if (!z.object(definition.inputShape).strict().safeParse(input).success) invalid();
    return toResult(await definition.handler(input));
  };
}
