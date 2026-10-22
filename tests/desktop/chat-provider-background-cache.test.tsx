// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";
import { startDesktopProviderCatalogCoordinator, stopDesktopProviderCatalogCoordinator } from "../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { desktopProviderIdentityKey } from "../../desktop/src/renderer/src/lib/provider-settings-identity";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const catalog = createCanonicalProviderCatalogFixture();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function rootApi(get: ReturnType<typeof vi.fn>) {
  return { ...createApiClient({ baseUrl: "https://platform.example.test", getRuntimeSlot: () => useConnection.getState().runtimeSlot }), get };
}
afterEach(() => {
  cleanup();
  stopDesktopProviderCatalogCoordinator();
  useConnection.setState(useConnection.getInitialState(), true);
  vi.restoreAllMocks();
});

it("shares discovery between simultaneous Electron Chat consumers", async () => {
  const api = { get: vi.fn().mockResolvedValue(catalog) };
  const first = renderHook(() => useChatProviderCatalog(catalog, { api }));
  const second = renderHook(() => useChatProviderCatalog(catalog, { api }));
  await waitFor(() => expect(first.result.current.status).toBe("ready"));
  await waitFor(() => expect(second.result.current.status).toBe("ready"));
  expect(api.get).toHaveBeenCalledOnce();
});

it("retains warm discovery through twenty hide/reopen cycles and after the last consumer unmounts", async () => {
  const api = { get: vi.fn().mockResolvedValue(catalog) };
  const first = renderHook(({ active }) => useChatProviderCatalog(catalog, { api, active }), { initialProps: { active: true } });
  await waitFor(() => expect(first.result.current.status).toBe("ready"));
  for (let index = 0; index < 20; index++) {
    first.rerender({ active: false });
    first.rerender({ active: true });
    expect(first.result.current.status).toBe("ready");
  }
  first.unmount();
  const reopened = renderHook(() => useChatProviderCatalog(catalog, { api }));
  expect(reopened.result.current.status).toBe("ready");
  expect(api.get).toHaveBeenCalledOnce();
});

it("does not fetch on application switching even when catalog freshness has expired", async () => {
  const api = { get: vi.fn().mockResolvedValue(catalog) };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
  for (let index = 0; index < 20; index++) act(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(api.get).toHaveBeenCalledOnce();
  expect(result.current.status).toBe("ready");
});

it("prewarms at authenticated application startup before Chat mounts", async () => {
  const api = { get: vi.fn().mockResolvedValue(catalog) };
  const { startDesktopProviderCatalogCoordinator } = await import("../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator");
  useConnection.setState({ status: "signed-in", api: api as never });
  const stop = startDesktopProviderCatalogCoordinator();
  await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
  await act(async () => undefined);
  const { result } = renderHook(() => useChatProviderCatalog(catalog));
  expect(result.current.initialLoading).toBe(false);
  expect(result.current.hasTrustedCatalog).toBe(true);
  expect(api.get).toHaveBeenCalledOnce();
  act(() => stop());
});

it("keeps background updates distinct from first load and synchronously suspends unknown Settings authority", async () => {
  let resolve!: (value: typeof catalog) => void;
  const pending = new Promise<typeof catalog>(yes => { resolve = yes; });
  const api = { get: vi.fn().mockResolvedValueOnce(catalog).mockReturnValue(pending) };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  await waitFor(() => expect(result.current.hasTrustedCatalog).toBe(true));
  act(() => result.current.refresh());
  expect(result.current).toMatchObject({ status: "ready", initialLoading: false, refreshing: true, hasTrustedCatalog: true });
  act(() => useConnection.getState().invalidateProviderCatalog(desktopProviderIdentityKey(useConnection.getState())));
  expect(result.current.initialLoading).toBe(false);
  expect(result.current.catalog.instances.every(i => i.availability === "unavailable")).toBe(true);
  await act(async () => resolve(catalog));
});
it("shows no ongoing first-load spinner while offline and starts one read after reconnect", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const api = { get: vi.fn().mockResolvedValue(catalog) };
  const { result } = renderHook(() => useChatProviderCatalog(catalog, { api }));
  expect(api.get).not.toHaveBeenCalled();
  expect(result.current.initialLoading).toBe(false);
  expect(result.current.catalog.instances.every(i => i.availability === "unavailable")).toBe(true);
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(result.current.hasTrustedCatalog).toBe(true));
  expect(api.get).toHaveBeenCalledOnce();
});

it.each([
  { userId: "another-user" }, { handle: "another-owner" },
  { platformHost: "https://another-platform.example.test" },
  { runtimeSlot: "pr-123" }, { authGeneration: 2 },
])("cancels and fences old root discovery across same-API identity changes: %j", async boundary => {
  const old = deferred<typeof catalog>();
  const next = deferred<typeof catalog>();
  const get = vi.fn().mockResolvedValueOnce(catalog).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const api = rootApi(get);
  useConnection.setState({ status: "signed-in", userId: "user-one", handle: "owner-one",
    platformHost: api.baseUrl, api });
  startDesktopProviderCatalogCoordinator();
  const { result } = renderHook(() => useChatProviderCatalog(catalog));
  await waitFor(() => expect(result.current.hasTrustedCatalog).toBe(true));
  act(() => result.current.refresh());
  const oldSignal = get.mock.calls[1]![1].signal as AbortSignal;
  act(() => useConnection.setState(boundary));
  expect(useConnection.getState().api).toBe(api);
  expect(oldSignal.aborted).toBe(true);
  expect(get).toHaveBeenCalledTimes(3);
  expect(result.current.hasTrustedCatalog).toBe(false);
  expect(result.current.catalog.instances.every(instance => instance.availability === "unavailable")).toBe(true);
  const stale = { ...catalog, instances: catalog.instances.map(instance => ({ ...instance, displayName: "Previous owner" })) };
  await act(async () => old.resolve(stale));
  expect(result.current.catalog.instances.some(instance => instance.displayName === "Previous owner")).toBe(false);
  expect(result.current.hasTrustedCatalog).toBe(false);
  const current = { ...catalog, instances: catalog.instances.map(instance => ({ ...instance, displayName: "Current owner" })) };
  await act(async () => next.resolve(current));
  expect(result.current.catalog).toEqual(current);
  expect(result.current.hasTrustedCatalog).toBe(true);
});

it("keeps unaffected root routes usable while failed post-mutation validation cannot restore a revoked route", async () => {
  const instance = catalog.instances[0]!;
  const twoRoutes = { ...catalog, instances: [instance, { ...instance, id: "other_instance", defaultSelection: undefined }] };
  const older = deferred<typeof twoRoutes>();
  const revalidation = deferred<typeof twoRoutes>();
  const get = vi.fn().mockResolvedValueOnce(twoRoutes).mockReturnValueOnce(older.promise).mockReturnValueOnce(revalidation.promise);
  useConnection.setState({ status: "signed-in", api: rootApi(get) });
  startDesktopProviderCatalogCoordinator();
  const { result } = renderHook(() => useChatProviderCatalog(twoRoutes));
  await waitFor(() => expect(result.current.hasTrustedCatalog).toBe(true));
  act(() => result.current.refresh());
  act(() => useConnection.getState().invalidateProviderCatalog(desktopProviderIdentityKey(useConnection.getState()), [instance.id]));
  const availability = () => result.current.catalog.instances.map(route => route.availability);
  expect(availability()).toEqual(["unavailable", "available"]);
  expect(result.current.initialLoading).toBe(false);
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => older.resolve(twoRoutes));
  expect(get).toHaveBeenCalledTimes(3);
  expect(get.mock.calls[2]![0]).toContain("refresh=true");
  expect(availability()).toEqual(["unavailable", "available"]);
  await act(async () => revalidation.reject(new Error("revalidation failed")));
  expect(result.current.refreshError).toBeTruthy();
  expect(availability()).toEqual(["unavailable", "available"]);
  expect(result.current.initialLoading).toBe(false);
});
