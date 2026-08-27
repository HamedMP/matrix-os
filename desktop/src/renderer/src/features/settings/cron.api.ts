import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../../lib/api";
import { desktopQueryScope, type DesktopQueryScope } from "../../lib/query-client";

export interface CronJob {
  id?: string;
  name?: string;
  schedule?: string;
  prompt?: string;
  enabled?: boolean;
}

export const cronKeys = {
  all: (scope: DesktopQueryScope) => ["cron", ...desktopQueryScope(scope)] as const,
  list: (scope: DesktopQueryScope) => ["cron", ...desktopQueryScope(scope), "list"] as const,
};

export function cronQueryOptions(api: ApiClient, scope: DesktopQueryScope) {
  return queryOptions({
    queryKey: cronKeys.list(scope),
    queryFn: async ({ signal }) => parseCronJobs(await api.get<unknown>("/api/cron", { signal })),
  });
}

export function parseCronJobs(value: unknown): CronJob[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { jobs?: unknown }).jobs)
      ? (value as { jobs: unknown[] }).jobs
      : value && typeof value === "object" && Array.isArray((value as { cron?: unknown }).cron)
        ? (value as { cron: unknown[] }).cron
        : [];
  return list.slice(0, 100).filter((record): record is CronJob => Boolean(record) && typeof record === "object");
}
