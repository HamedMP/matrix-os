import type { AgentId } from "./activation-contracts.js";
import type { MatrixProjectOption, SymphonyRunStatus } from "../symphony/contracts.js";

export type CodingHandoffStatus = "idle" | "running" | "needs_input" | "ready" | "failed";

export interface CodingSetupStatus {
  githubConnected: boolean;
  selectedProject: MatrixProjectOption | null;
  issueSourceConfigured: boolean;
  symphonyReady: boolean;
  terminalReady: boolean;
  activeAgents: AgentId[];
  handoffStatus: CodingHandoffStatus;
}

export interface CodingSetupProvider {
  getCodingSetup(ownerId: string): Promise<CodingSetupStatus>;
}

export interface CodingSetupAggregationDeps {
  hasGitHubConnection: (ownerId: string) => Promise<boolean>;
  listMatrixProjects: (ownerId: string) => Promise<MatrixProjectOption[]>;
  getSelectedProjectSlug?: (ownerId: string) => Promise<string | null>;
  hasIssueSource: (ownerId: string) => Promise<boolean>;
  getSymphonyStatus: (ownerId: string) => Promise<{
    ready: boolean;
    runStatuses: SymphonyRunStatus[];
    activeAgents: AgentId[];
  }>;
  hasTerminalContext: (ownerId: string, projectSlug: string | null) => Promise<boolean>;
}

function deriveHandoffStatus(statuses: SymphonyRunStatus[]): CodingHandoffStatus {
  if (statuses.some((status) => status === "blocked")) return "needs_input";
  if (statuses.some((status) => status === "failed" || status === "stopped")) return "failed";
  if (statuses.some((status) => status === "queued" || status === "running" || status === "retrying")) return "running";
  if (statuses.some((status) => status === "handoff" || status === "completed")) return "ready";
  return "idle";
}

export function createCodingSetupProvider(deps: CodingSetupAggregationDeps): CodingSetupProvider {
  return {
    async getCodingSetup(ownerId: string): Promise<CodingSetupStatus> {
      const [githubConnected, projects, selectedProjectSlug, issueSourceConfigured, symphony] = await Promise.all([
        deps.hasGitHubConnection(ownerId),
        deps.listMatrixProjects(ownerId),
        deps.getSelectedProjectSlug?.(ownerId) ?? Promise.resolve(null),
        deps.hasIssueSource(ownerId),
        deps.getSymphonyStatus(ownerId),
      ]);
      const selectedProject = selectedProjectSlug
        ? projects.find((project) => project.slug === selectedProjectSlug) ?? null
        : null;
      const terminalReady = await deps.hasTerminalContext(ownerId, selectedProject?.slug ?? null);

      return {
        githubConnected,
        selectedProject,
        issueSourceConfigured,
        symphonyReady: symphony.ready,
        terminalReady,
        activeAgents: symphony.activeAgents.includes("hermes")
          ? symphony.activeAgents
          : [...symphony.activeAgents, "hermes"],
        handoffStatus: deriveHandoffStatus(symphony.runStatuses),
      };
    },
  };
}
