/**
 * S07 / T039: readiness input for the sandbox policy.
 *
 * Shared runs (projects and standalone Chats) execute only inside the scope
 * runtime sandbox, so a home whose supervisor does not advertise the pinned
 * sandbox policy reports those resources as `unsupported` rather than
 * launching a wider profile. Files, folders and app instances do not execute
 * anything, and a terminal can always be observed; controller access on a
 * terminal is decided by the task profile (terminal-task-profile.ts), not here.
 */
import type { CollaborationResourceKind } from "@matrix-os/contracts";
import type { ScopeRuntimeCapability } from "./scope-runtime-client.js";
import type { ReadinessProbes, ReadinessSubject } from "./readiness-evaluator.js";

const EXECUTING_KINDS: ReadonlySet<CollaborationResourceKind> = new Set(["project", "chat"]);

export interface SandboxReadinessProbe extends Pick<ReadinessProbes, "supported"> {
  /** True when the supervisor can launch a sandbox-only terminal workload. */
  sandboxTerminalSupported(): Promise<boolean>;
  /** True when the supervisor can launch sandboxed shared Chat runs. */
  sandboxRunsSupported(): Promise<boolean>;
}

export function createSandboxReadinessProbe(options: {
  client: { capability(): ScopeRuntimeCapability };
}): SandboxReadinessProbe {
  function sandboxFor(workload: "chat_ai" | "terminal"): boolean {
    const capability = options.client.capability();
    return capability.available && capability.sandbox !== undefined
      && capability.sandbox.workloads.includes(workload);
  }
  return {
    async supported(subject: ReadinessSubject): Promise<boolean> {
      if (!EXECUTING_KINDS.has(subject.resourceKind)) return true;
      return sandboxFor("chat_ai");
    },
    async sandboxTerminalSupported(): Promise<boolean> {
      return sandboxFor("terminal");
    },
    async sandboxRunsSupported(): Promise<boolean> {
      return sandboxFor("chat_ai");
    },
  };
}
