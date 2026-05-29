import type { AgentId, CodingHandoffStatus } from "./activation-contracts.js";
import type { MatrixProjectOption, SymphonyRunStatus } from "../symphony/types.js";

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
  hasGitHubConnection: (ownerId: string, selectedProject: MatrixProjectOption | null) => Promise<boolean>;
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
  if (statuses.some((status) => status === "handoff" || status === "completed")) return "ready";
  if (statuses.some((status) => status === "queued" || status === "running" || status === "retrying")) return "running";
  if (statuses.some((status) => status === "failed" || status === "stopped")) return "failed";
  return "idle";
}

export function createCodingSetupProvider(deps: CodingSetupAggregationDeps): CodingSetupProvider {
  return {
    async getCodingSetup(ownerId: string): Promise<CodingSetupStatus> {
      const [projects, selectedProjectSlug, issueSourceConfigured, symphony] = await Promise.all([
        deps.listMatrixProjects(ownerId),
        deps.getSelectedProjectSlug?.(ownerId) ?? Promise.resolve(null),
        deps.hasIssueSource(ownerId),
        deps.getSymphonyStatus(ownerId),
      ]);
      const selectedProject = selectedProjectSlug
        ? projects.find((project) => project.slug === selectedProjectSlug) ?? null
        : null;
      const [githubConnected, terminalReady] = await Promise.all([
        deps.hasGitHubConnection(ownerId, selectedProject),
        deps.hasTerminalContext(ownerId, selectedProject?.slug ?? null),
      ]);

      return {
        githubConnected,
        selectedProject,
        issueSourceConfigured,
        symphonyReady: symphony.ready,
        terminalReady,
        activeAgents: [...symphony.activeAgents, "hermes"],
        handoffStatus: deriveHandoffStatus(symphony.runStatuses),
      };
    },
  };
}
