import type { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { brainReadToolDefinitions, type BrainAgentReadTools } from "./brain-read-tools.js";
import {
  BRAIN_WHY_DESCRIPTION, BRAIN_WHY_INPUT_SHAPE, createBrainWhyToolHandler, type BrainAgentTools,
} from "./brain-why.js";

// The Company Brain tools on the kernel IPC server, kept here so ipc-server.ts only composes them.

export type { BrainAgentReadTools, BrainAgentTools };

const READ_ONLY = { annotations: { readOnlyHint: true } };

/** brain_why, then the read tools, each only when the gateway injected it; every tool is read-only. */
export function createBrainIpcTools(tool: typeof sdkTool, why?: BrainAgentTools, read?: BrainAgentReadTools) {
  return [
    ...(why
      ? [tool("brain_why", BRAIN_WHY_DESCRIPTION, BRAIN_WHY_INPUT_SHAPE, createBrainWhyToolHandler(why), READ_ONLY)]
      : []),
    ...(read ? brainReadToolDefinitions(read).map((definition) => tool(definition.name, definition.description,
      definition.inputShape, definition.handler, READ_ONLY)) : []),
  ];
}
