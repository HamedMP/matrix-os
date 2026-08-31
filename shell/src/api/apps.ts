import { queryOptions } from "@tanstack/react-query";
import type { ApiAppEntry } from "@/lib/design-apps-refresh";
import { shellApi, type RequestOptions } from "./http";

type AppsLoader = (options?: RequestOptions) => Promise<ApiAppEntry[]>;

export const appKeys = {
  all: () => ["apps"] as const,
  list: () => ["apps", "list"] as const,
};

export async function listApps(options?: RequestOptions): Promise<ApiAppEntry[]> {
  const value = await shellApi.get<unknown>("/api/apps", options);
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).filter((entry): entry is ApiAppEntry => (
    Boolean(entry)
    && typeof entry === "object"
    && typeof (entry as ApiAppEntry).name === "string"
    && typeof (entry as ApiAppEntry).path === "string"
  ));
}

export function appsQueryOptions(loader: AppsLoader = listApps) {
  return queryOptions({
    queryKey: appKeys.list(),
    queryFn: ({ signal }) => loader({ signal }),
  });
}
