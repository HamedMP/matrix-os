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
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
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
