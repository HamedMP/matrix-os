import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../../lib/api";
import { desktopQueryScope, type DesktopQueryScope } from "../../lib/query-client";
import { parseApps } from "../../stores/apps";

export const appKeys = {
  all: (scope: DesktopQueryScope) => ["apps", ...desktopQueryScope(scope)] as const,
  list: (scope: DesktopQueryScope) => ["apps", ...desktopQueryScope(scope), "list"] as const,
};

export function appsQueryOptions(api: ApiClient, scope: DesktopQueryScope) {
  return queryOptions({
    queryKey: appKeys.list(scope),
    queryFn: async ({ signal }) => parseApps(await api.get<unknown>("/api/apps", { signal })),
  });
}
