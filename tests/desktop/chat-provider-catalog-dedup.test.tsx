// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "../../shell/src/lib/canonical-provider-setup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}
function withRevision(catalog: ReturnType<typeof createCanonicalProviderCatalogFixture>, revision: string) {
  return { ...catalog, revision, instances: catalog.instances.map(instance => ({ ...instance, catalogRevision: revision })) };
}
function foregroundEvents() {
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
}
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  useConnection.setState(useConnection.getInitialState(), true);
});

it("joins initial native discovery for a concurrent focus/visibility pair without another read", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const pending = deferred<typeof catalog>();
  const api = { get: vi.fn(() => pending.promise) };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  expect(result.current.status).toBe("loading");
  act(foregroundEvents);
  expect(api.get).toHaveBeenCalledOnce();
  expect(result.current.status).toBe("loading");
  await act(async () => pending.resolve(catalog));
  expect(result.current.status).toBe("ready");
  expect(api.get).toHaveBeenCalledOnce();
});

it("reuses freshly trusted native discovery when opening a picker also activates its window", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const api = { get: vi.fn().mockResolvedValue(catalog) };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  for (let index = 0; index < 3; index++) act(foregroundEvents);
  expect(api.get).toHaveBeenCalledOnce();
  expect(result.current.status).toBe("ready");
  expect(result.current.hasTrustedCatalog).toBe(true);
});

it("coalesces stale native lifecycle revalidation and reuses its completed discovery for another minute", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const catalog = createCanonicalProviderCatalogFixture();
  const pending = deferred<typeof catalog>();
  const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockReturnValueOnce(pending.promise).mockResolvedValue(catalog) };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  now += 59_999;
  act(foregroundEvents);
  expect(api.get).toHaveBeenCalledOnce();
  expect(result.current.status).toBe("ready");
  now += 1;
  act(foregroundEvents);
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(result.current.status).toBe("loading");
  await act(async () => pending.resolve(catalog));
  expect(result.current.status).toBe("ready");
  act(() => window.dispatchEvent(new Event("focus")));
  expect(api.get).toHaveBeenCalledTimes(2);
  now += 60_000;
  act(foregroundEvents);
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(api.get).toHaveBeenCalledTimes(3);
});

it("bypasses fresh lifecycle reuse for explicit refresh and immediately retries its failure", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const get = vi.fn().mockResolvedValueOnce(catalog).mockRejectedValueOnce(new Error("refresh_failed"))
    .mockResolvedValue(catalog);
  const api = { get };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(get).toHaveBeenCalledTimes(2);
  act(foregroundEvents);
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(get).toHaveBeenCalledTimes(3);
});

it.each(["pending", "ready"] as const)("does not restart %s same-scope discovery when a fallback presentation is rebuilt", async status => {
  const catalog = createCanonicalProviderCatalogFixture();
  const pending = deferred<typeof catalog>();
  const api = { get: vi.fn(() => pending.promise) };
  const { result, rerender } = renderHook(({ fallback }) => useChatProviderCatalog(fallback, { api }), { initialProps: { fallback: catalog } });
  if (status === "ready") await act(async () => pending.resolve(catalog));
  // The fallback is only local presentation; it grants no new authority.
  rerender({ fallback: withRevision(catalog, "local_project_presentation_changed") });
  expect(api.get).toHaveBeenCalledOnce();
  expect(result.current.status).toBe(status === "ready" ? "ready" : "loading");
  await act(async () => pending.resolve(catalog));
  expect(result.current.catalog.revision).toBe(catalog.revision);
  expect(result.current.hasTrustedCatalog).toBe(true);
  expect(api.get).toHaveBeenCalledOnce();
});

it("does not discard an explicit post-change native refresh just because an older discovery is pending", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const older = deferred<typeof catalog>();
  const newer = withRevision(catalog, "after_explicit_refresh");
  const api = { get: vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(newer) };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.catalog.revision).toBe(newer.revision));
  expect(api.get).toHaveBeenCalledTimes(2);
  await act(async () => older.resolve(catalog));
  expect(result.current.catalog.revision).toBe(newer.revision);
});

it("joins pending Web discovery for lifecycle events without queuing a redundant follow-up", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const pending = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(pending.promise).mockImplementation(async () => Response.json(catalog));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useChatProviderState());
  act(foregroundEvents);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.current.loading).toBe(true);
  await act(async () => pending.resolve(Response.json(catalog)));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.current.loading).toBe(false);
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("still queues an explicit Web Settings invalidation behind pending discovery", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const pending = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(pending.promise).mockImplementation(async () => Response.json(withRevision(catalog, "after_settings")));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useChatProviderState());
  act(foregroundEvents);
  act(() => window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGED_EVENT)));
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(Response.json(catalog)));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[1][0])).toContain("refresh=true");
  expect(result.current.catalog?.revision).toBe("after_settings");
});
