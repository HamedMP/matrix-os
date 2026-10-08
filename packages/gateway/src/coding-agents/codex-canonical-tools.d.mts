import type { CanonicalExecutionPolicy, CanonicalOwnerScope } from "@matrix-os/contracts";
import type {
  CodingAgentCanonicalActionRequest,
  CodingAgentCanonicalExecution,
  CodingAgentCanonicalToolResult,
} from "./provider-adapter.js";

export declare function canonicalCodexJson(value: unknown): string;
export declare function codexCanonicalDigest(value: unknown): string;
export declare function freezeCodexCanonicalInventory(
  policyValue: unknown,
  inventoryValue: unknown,
): {
  executionPolicy: CodingAgentCanonicalExecution["executionPolicy"];
  descriptors: readonly CodingAgentCanonicalExecution["inventory"][number][];
  inventoryDigest: string;
  tools: readonly unknown[];
};

/**
 * Parent-side half of the canonical bridge. Re-validates the journaled
 * request byte-for-byte against the launch grant before the authority is
 * invoked, then delivers the bound result frame over the control channel.
 */
export declare function invokeCodexCanonicalAction(
  record: CodingAgentCanonicalActionRequest,
  input: {
    executionPolicy: CanonicalExecutionPolicy;
    inventory: CodingAgentCanonicalExecution["inventory"];
    owner: CanonicalOwnerScope;
    chatId: string;
    runId: string;
    actions: { invoke(input: {
      owner: CanonicalOwnerScope; chatId: string; runId: string; actionId: string;
      toolId: string; arguments: unknown; executionPolicy: CanonicalExecutionPolicy;
      signal: AbortSignal;
    }): Promise<unknown> };
    signal: AbortSignal;
  },
  sendResult: (frame: CodingAgentCanonicalToolResult) => Promise<void> | void,
): Promise<void>;
