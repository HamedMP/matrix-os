import type { TuiGatewayClient } from "./gateway-client.js";

type GatewayLike = Pick<TuiGatewayClient, "requestJson">;

function enc(value: string): string {
  return encodeURIComponent(value);
}

export interface ProjectSummary { slug: string; name?: string }
export interface WorktreeSummary { id: string; projectSlug: string; branch?: string; path?: string }

export function createProjectsClient(gateway: GatewayLike) {
  return {
    async listProjects(): Promise<ProjectSummary[]> {
      const payload = await gateway.requestJson("/api/workspace/projects");
      return typeof payload === "object" && payload !== null && Array.isArray((payload as { projects?: unknown[] }).projects)
        ? (payload as { projects: ProjectSummary[] }).projects
        : [];
    },
    async createProject(input: { url: string; slug?: string }) {
      return gateway.requestJson("/api/projects", { method: "POST", body: JSON.stringify(input) });
    },
    async getProject(slug: string) {
      return gateway.requestJson(`/api/projects/${enc(slug)}`);
    },
    async deleteProject(slug: string) {
      return gateway.requestJson(`/api/projects/${enc(slug)}`, { method: "DELETE", body: JSON.stringify({}) });
    },
    async listWorktrees(projectSlug: string): Promise<WorktreeSummary[]> {
      const payload = await gateway.requestJson(`/api/projects/${enc(projectSlug)}/worktrees`);
      return typeof payload === "object" && payload !== null && Array.isArray((payload as { worktrees?: unknown[] }).worktrees)
        ? (payload as { worktrees: WorktreeSummary[] }).worktrees
        : [];
    },
    async createWorktree(projectSlug: string, input: { branch?: string; pullRequest?: number }) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/worktrees`, { method: "POST", body: JSON.stringify(input) });
    },
    async deleteWorktree(projectSlug: string, worktreeId: string) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/worktrees/${enc(worktreeId)}`, { method: "DELETE", body: JSON.stringify({}) });
    },
  };
}
