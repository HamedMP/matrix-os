import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { AgentStatus } from "../agent-launcher.js";
import type { AgentRuntimeSource } from "../agent-config/service.js";

type Driver = AiProviderSnapshotV3["drivers"][number];

function runtimeHealth(health: "healthy" | "degraded" | "stopped" | "unreachable" | "unknown") {
  if (health === "healthy") return "ready" as const;
  if (health === "unreachable") return "unavailable" as const;
  return health;
}

function runtimeDriver(runtime: Awaited<ReturnType<AgentRuntimeSource>>["runtime"]["options"][number]): Driver {
  return {
    id: runtime.id,
    displayName: runtime.displayName,
    kind: "cli",
    installState: runtime.installState,
    health: runtimeHealth(runtime.health),
    capabilities: ["tools", "resume", "reasoning"],
    setupActions: runtime.installState === "missing"
      ? ["install"]
      : runtime.selectionState === "action_required"
        ? ["open_terminal"]
        : [],
  };
}

function agentDriver(agent: AgentStatus): Driver {
  const id = agent.id === "claude" ? "claude_code" : agent.id;
  const setupActions: Driver["setupActions"] = agent.installState === "missing"
    ? ["install"]
    : agent.installState === "installed" && agent.authState === "required"
      ? ["connect_account", "open_terminal"]
      : agent.installState === "installed" && (agent.id === "opencode" || agent.id === "pi")
        ? ["open_terminal"]
        : [];
  const health = agent.installState !== "installed"
    ? agent.installState === "missing" ? "stopped" as const : "unknown" as const
    : agent.authState === "ok" ? "ready" as const
      : agent.authState === "required" ? "stopped" as const
        : agent.authState === "error" ? "unavailable" as const : "unknown" as const;
  return {
    id,
    displayName: agent.displayName,
    kind: "cli",
    installState: agent.installState,
    health,
    capabilities: ["tools", "resume", "reasoning", "project_context"],
    setupActions,
  };
}

export function createProviderDriverInventoryReader(options: {
  detectAgentInstallations: () => Promise<{ agents: AgentStatus[] }>;
  runtimeSource: AgentRuntimeSource;
}): (signal: AbortSignal) => Promise<AiProviderSnapshotV3["drivers"]> {
  if (typeof options.detectAgentInstallations !== "function") {
    throw new Error("Agent installation inventory is required");
  }
  if (typeof options.runtimeSource !== "function") {
    throw new Error("Agent runtime inventory is required");
  }
  return async (signal) => {
    signal.throwIfAborted();
    const [runtime, installations] = await Promise.all([
      options.runtimeSource(signal),
      options.detectAgentInstallations(),
    ]);
    signal.throwIfAborted();
    return [
      ...runtime.runtime.options.map(runtimeDriver),
      ...installations.agents.map(agentDriver),
    ];
  };
}
