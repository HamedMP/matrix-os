// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup.js";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "../../shell/src/lib/canonical-provider-setup.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

const healthy = createCanonicalProviderCatalogFixture();
const checking = { ...healthy, instances: healthy.instances.map(instance => ({ ...instance,
  availability: "unavailable", observationState: "checking", unavailabilityReason: "runtime_unavailable",
  defaultSelection: undefined, models: instance.models.map(model => ({ ...model, availability: "unavailable" })),
})) };
function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("ignores a pre-mutation observation and spends the retry budget only on the current generation", async () => {
  const before = deferred(), after = deferred();
  const fetch = vi.fn().mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    .mockImplementation(async () => Response.json(healthy));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useChatProviderState());
  act(() => window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGED_EVENT)));
  await act(async () => before.resolve(Response.json(checking)));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.catalog).toBeNull();
  await act(async () => after.resolve(Response.json(checking)));
  await act(async () => vi.advanceTimersByTimeAsync(4999));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(result.current.catalog?.instances[0]?.availability).toBe("available");
});

it("pauses short retries offline and resumes one current check when the network returns", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const fetch = vi.fn(async () => Response.json(checking));
  vi.stubGlobal("fetch", fetch);
  renderHook(() => useChatProviderState());
  await act(async () => { await Promise.resolve(); });
  expect(fetch).toHaveBeenCalledOnce();
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(fetch).toHaveBeenCalledOnce();
  online.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("restores current catalog trust after an accepted settings change while offline", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(healthy));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useChatProviderState());
  await act(async () => { await Promise.resolve(); });
  expect(result.current.hasTrustedCatalog).toBe(true);
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGED_EVENT)));
  expect(result.current.hasTrustedCatalog).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
  online.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1]?.[0])).toContain("refresh=true");
  expect(result.current.hasTrustedCatalog).toBe(true);
});

it("preserves explicit refresh intent while offline until one online forced read", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(healthy));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useChatProviderState());
  await act(async () => { await Promise.resolve(); });
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => result.current.refresh());
  expect(fetch).toHaveBeenCalledOnce();
  online.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1]?.[0])).toContain("refresh=true");
});

it("does not drain a queued settings refresh offline after the active read settles", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const current = deferred();
  const fetch = vi.fn().mockReturnValueOnce(current.promise).mockImplementation(async () => Response.json(healthy));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useChatProviderState());
  act(() => window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGED_EVENT)));
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  await act(async () => current.resolve(Response.json(healthy)));
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.current.hasTrustedCatalog).toBe(false);
  online.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1]?.[0])).toContain("refresh=true");
  expect(result.current.hasTrustedCatalog).toBe(true);
});

it("queues retained offline settings intent when online returns before the active read completes", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const current = deferred();
  const fetch = vi.fn().mockReturnValueOnce(current.promise).mockImplementation(async () => Response.json(healthy));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useChatProviderState());
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGED_EVENT)));
  online.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("online")));
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => current.resolve(Response.json(healthy)));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1]?.[0])).toContain("refresh=true");
  expect(result.current.hasTrustedCatalog).toBe(true);
});

it("continues bounded checking recovery after a short retry fails", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(checking))
    .mockRejectedValueOnce(new Error("NetworkUnavailable"))
    .mockImplementation(async () => Response.json(healthy));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useChatProviderState());
  await act(async () => { await Promise.resolve(); });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.unavailable).toBe(true);
  expect(result.current.catalog?.instances[0]?.observationState).toBe("checking");
  await act(async () => vi.advanceTimersByTimeAsync(14999));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(result.current.unavailable).toBe(false);
  expect(result.current.catalog?.instances[0]?.availability).toBe("available");
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("ignores a rejected pre-settings retry without spending the new generation recovery budget", async () => {
  const before = deferred(), after = deferred();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(checking))
    .mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    .mockImplementation(async () => Response.json(healthy));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useChatProviderState());
  await act(async () => { await Promise.resolve(); });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  act(() => window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGED_EVENT)));
  await act(async () => before.reject(new Error("ObsoleteNetworkFailure")));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(result.current.unavailable).toBe(false);
  expect(result.current.hasTrustedCatalog).toBe(false);
  await act(async () => after.resolve(Response.json(checking)));
  expect(result.current.hasTrustedCatalog).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(4999));
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(result.current.catalog?.instances[0]?.availability).toBe("available");
});

it("exhausts failed short retries before returning to ordinary checking cadence and cancels on teardown", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(checking)).mockRejectedValue(new Error("NetworkUnavailable"));
  vi.stubGlobal("fetch", fetch);
  const { unmount } = renderHook(() => useChatProviderState());
  await act(async () => { await Promise.resolve(); });
  for (const [delay, reads] of [[5000, 2], [15000, 3], [30000, 4]]) {
    await act(async () => vi.advanceTimersByTimeAsync(delay!));
    expect(fetch).toHaveBeenCalledTimes(reads!);
  }
  await act(async () => vi.advanceTimersByTimeAsync(299999));
  expect(fetch).toHaveBeenCalledTimes(4);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(5);
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  expect(fetch).toHaveBeenCalledTimes(5);
});
