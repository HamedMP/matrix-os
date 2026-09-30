import type { AgentId, CodingHandoffStatus } from "./activation-contracts.js";

export interface MatrixProjectOption {
  slug: string;
  name: string;
  repositoryUrl?: string;
  updatedAt?: string;
}

export interface CodingSetupStatus {
  githubConnected: boolean;
  selectedProject: MatrixProjectOption | null;
  issueSourceConfigured: boolean;
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
  hasTerminalContext: (ownerId: string, projectSlug: string | null) => Promise<boolean>;
}

export function createCodingSetupProvider(deps: CodingSetupAggregationDeps): CodingSetupProvider {
  return {
    async getCodingSetup(ownerId: string): Promise<CodingSetupStatus> {
      const [projects, selectedProjectSlug, issueSourceConfigured] = await Promise.all([
        deps.listMatrixProjects(ownerId),
        deps.getSelectedProjectSlug?.(ownerId) ?? Promise.resolve(null),
        deps.hasIssueSource(ownerId),
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
        terminalReady,
        activeAgents: ["hermes"],
        handoffStatus: "idle",
      };
    },
  };
}
