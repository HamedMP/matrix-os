import type { ApiClient } from "./api";

// Weak keys make the cache runtime-scoped without retaining disconnected API
// clients. The first Desktop consumers share one read; explicit refreshes
// replace it after focus or a background settings change.
const desktopConfigRequests = new WeakMap<ApiClient, Promise<unknown>>();

export function loadNativeDesktopConfig(
  api: ApiClient,
  options: { refresh?: boolean } = {},
): Promise<unknown> {
  const existing = desktopConfigRequests.get(api);
  if (existing && !options.refresh) return existing;

  const pending = api.get<unknown>("/api/settings/desktop");
  desktopConfigRequests.set(api, pending);
  void pending.catch(() => {
    if (desktopConfigRequests.get(api) === pending) desktopConfigRequests.delete(api);
  });
  return pending;
}
