import { type RefreshBinding } from "@matrix-os/contracts/data-imports";
export { RefreshNameSchema, RefreshBindingSchema, type RefreshBinding } from "@matrix-os/contracts/data-imports";
export type RefreshStatus = "pending" | "running" | "complete" | "backoff" | "failed" | "exhausted";
export interface RefreshJob {
  id: string; ownerId: string; binding: RefreshBinding; revision: number; status: RefreshStatus;
  cursor: Record<string, unknown> | null; checkpoint: Record<string, unknown> | null;
  calls: number; pages: number; bytes: number; failures: number;
  leaseToken: string | null; leaseExpiresAt: string | null; retryAt: string | null;
  errorCode: "source_unavailable" | "budget_exhausted" | null;
}
export const REFRESH_LIMITS = { maxJobs: 50, maxPages: 5, maxCalls: 8, maxBytes: 2 * 1024 * 1024, maxPageBytes: 512 * 1024, leaseMs: 45000 } as const;
export class IntegrationRefreshError extends Error {
  constructor(readonly code: "denied" | "invalid" | "conflict" | "unavailable" | "budget") {
    super("Data import is unavailable"); this.name = "IntegrationRefreshError";
  }
}
export function publicRefreshJob(job: RefreshJob) {
  return { sourceId: job.binding.sourceId, appId: job.binding.appId, service: job.binding.service, action: job.binding.action,
    status: job.status, pages: job.pages, calls: job.calls, bytes: job.bytes, retryAt: job.retryAt, errorCode: job.errorCode };
}
