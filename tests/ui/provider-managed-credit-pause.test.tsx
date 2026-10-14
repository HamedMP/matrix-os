// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettingsController, useProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { observation, snapshot, start } from "./provider-managed-credit-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("removes its exact four wake listeners and timer when Settings unmounts", async () => {
  const addWindow = vi.spyOn(window, "addEventListener");
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const addDocument = vi.spyOn(document, "addEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  const transport = { getSnapshot: vi.fn().mockResolvedValue(snapshot()), getManagedCredit: vi.fn(async () => observation()), mutate: vi.fn() };
  const view = renderHook(() => useProviderSettingsController({ identityKey: "teardown", transport, automaticCreditRefreshEnabled: true }));
  await act(async () => {});
  const listeners = ["focus", "online", "offline"].map(event => [event, addWindow.mock.calls.find(([name]) => name === event)?.[1]] as const);
  const visibility = addDocument.mock.calls.find(([name]) => name === "visibilitychange")?.[1];
  view.unmount(); await act(async () => {});
  for (const [event, handler] of listeners) {
    expect(handler).toBeDefined(); expect(removeWindow).toHaveBeenCalledWith(event, handler);
  }
  expect(visibility).toBeDefined(); expect(removeDocument).toHaveBeenCalledWith("visibilitychange", visibility);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(360_000); window.dispatchEvent(new Event("focus")); });
  expect(transport.getManagedCredit).not.toHaveBeenCalled();
});

it("does not start a queued transport after its owner already cancelled it", async () => {
  const getManagedCredit = vi.fn(async () => observation());
  const controller = new ProviderSettingsController({ identityKey: "cancel-before-start", transport: {
    getSnapshot: vi.fn().mockResolvedValue(snapshot()), getManagedCredit, mutate: vi.fn(),
  } });
  await controller.refresh({ refresh: false });
  const abort = new AbortController();
  const pending = controller.refreshManagedCredit(abort.signal);
  abort.abort();
  expect(await pending).toBe("aborted");
  expect(getManagedCredit).not.toHaveBeenCalled();
  controller.dispose();
});

it.each(["visibility", "offline"])("reconciles an overdue %s return immediately after its cancelled request settles", async reason => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const getSnapshot = vi.fn().mockResolvedValue(snapshot());
  let active = 0; let maxActive = 0;
  const getManagedCredit = vi.fn().mockImplementationOnce((signal: AbortSignal) => new Promise((_resolve, reject) => {
    maxActive = Math.max(maxActive, ++active);
    signal.addEventListener("abort", () => queueMicrotask(() => { active--; reject(new DOMException("Paused", "AbortError")); }), { once: true });
  })).mockImplementation(async () => {
    maxActive = Math.max(maxActive, ++active); active--; return observation(3_000_000);
  });
  const transport = { getSnapshot, getManagedCredit, mutate: vi.fn() };
  const view = renderHook(() => useProviderSettingsController({ identityKey: reason, transport, automaticCreditRefreshEnabled: true }));
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(getManagedCredit).toHaveBeenCalledTimes(1);
  await act(async () => {
    if (reason === "visibility") { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); }
    else { online.mockReturnValue(false); window.dispatchEvent(new Event("offline")); }
    // Return before the transport's cancellation continuation is delivered.
    visibility.mockReturnValue("visible"); online.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus"));
  });
  expect(getManagedCredit).toHaveBeenCalledTimes(2);
  expect(maxActive).toBe(1);
  expect(view.result.current.snapshot?.accessSources[0]?.usage).toEqual(observation(3_000_000).usage);
  expect(getSnapshot).toHaveBeenCalledTimes(1);
  view.unmount(); await act(async () => {}); expect(vi.getTimerCount()).toBe(0);
});
