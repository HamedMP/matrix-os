import type { TuiGatewayClient } from "./gateway-client.js";

type GatewayLike = Pick<TuiGatewayClient, "requestJson">;
function enc(value: string): string { return encodeURIComponent(value); }
function qs(input: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value));
  const out = params.toString();
  return out ? `?${out}` : "";
}

export function createWorkspaceClient(gateway: GatewayLike) {
  return {
    async listReviews(input: { projectSlug?: string; status?: string } = {}) {
      return gateway.requestJson(`/api/reviews${qs(input)}`);
    },
    async nextReview(reviewId: string) {
      return gateway.requestJson(`/api/reviews/${enc(reviewId)}/next`, { method: "POST", body: JSON.stringify({}) });
    },
    async approveReview(reviewId: string) {
      return gateway.requestJson(`/api/reviews/${enc(reviewId)}/approve`, { method: "POST", body: JSON.stringify({}) });
    },
    async stopReview(reviewId: string) {
      return gateway.requestJson(`/api/reviews/${enc(reviewId)}/stop`, { method: "POST", body: JSON.stringify({}) });
    },
    async listTasks(projectSlug: string, input: { includeArchived?: boolean } = {}) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/tasks${qs(input)}`);
    },
    async createTask(projectSlug: string, input: { title: string; priority?: string }) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/tasks`, { method: "POST", body: JSON.stringify(input) });
    },
    async updateTask(projectSlug: string, taskId: string, input: Record<string, unknown>) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/tasks/${enc(taskId)}`, { method: "PATCH", body: JSON.stringify(input) });
    },
    async deleteTask(projectSlug: string, taskId: string) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/tasks/${enc(taskId)}`, { method: "DELETE", body: JSON.stringify({}) });
    },
    async listPreviews(projectSlug: string, input: { taskId?: string } = {}) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/previews${qs(input)}`);
    },
    async createPreview(projectSlug: string, input: { taskId?: string; label: string; url: string }) {
      return gateway.requestJson(`/api/projects/${enc(projectSlug)}/previews`, { method: "POST", body: JSON.stringify(input) });
    },
    async listEvents(input: { projectSlug?: string; taskId?: string } = {}) {
      return gateway.requestJson(`/api/workspace/events${qs(input)}`);
    },
    async exportWorkspace(input: { projectSlug?: string } = {}) {
      return gateway.requestJson("/api/workspace/export", { method: "POST", body: JSON.stringify(input) });
    },
    async deleteWorkspaceData(input: { projectSlug?: string; confirmation: string }) {
      return gateway.requestJson("/api/workspace/data", { method: "DELETE", body: JSON.stringify(input) });
    },
  };
}
