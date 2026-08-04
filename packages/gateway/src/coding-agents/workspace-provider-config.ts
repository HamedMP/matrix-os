import { z } from "zod/v4";
import type { SupportedAgent } from "../agent-launcher.js";
import { codexExecutableFromEnv } from "./codex-executable.js";

const WorkspaceProviderAgentSchema = z.enum(["claude", "codex", "pi"]);
const WorkspaceProviderAgentsSchema = z.array(WorkspaceProviderAgentSchema)
  .max(3)
  .superRefine((agents, ctx) => {
    if (agents.some((agent, index) => agents.indexOf(agent) !== index)) {
      ctx.addIssue({ code: "custom", message: "Duplicate provider" });
    }
  });
const ExplicitWorkspaceProvidersSchema = z.string()
  .max(64)
  .transform((value) => value.trim() === "" ? [] : value.split(",").map((agent) => agent.trim()))
  .pipe(WorkspaceProviderAgentsSchema);

interface WorkspaceProviderEnvironment {
  [key: string]: string | undefined;
  MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER?: string;
  MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS?: string;
  MATRIX_NODE_PREFIX?: string;
}

export function resolveWorkspaceProviderRuntime(
  environment: WorkspaceProviderEnvironment,
): { agents: SupportedAgent[]; codexExecutable: string | undefined } {
  const agents = configuredWorkspaceProviderAgents(environment);
  return {
    agents,
    codexExecutable: agents.includes("codex")
      ? codexExecutableFromEnv(environment)
      : undefined,
  };
}

export function configuredWorkspaceProviderAgents(
  environment: WorkspaceProviderEnvironment,
): SupportedAgent[] {
  const explicit = environment.MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS;
  if (explicit !== undefined) {
    const parsed = ExplicitWorkspaceProvidersSchema.safeParse(explicit);
    if (!parsed.success) {
      throw new Error("Invalid coding-agent workspace provider configuration");
    }
    return parsed.data;
  }

  const legacy = environment.MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER;
  if (legacy === undefined || legacy === "0") return [];
  if (legacy === "1") return ["codex"];
  throw new Error("Invalid coding-agent workspace provider configuration");
}
