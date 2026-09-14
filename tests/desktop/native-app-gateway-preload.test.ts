import { afterEach, expect, it, vi } from "vitest";
import { createNativeAppGatewayFetch } from "@desktop/shared/native-app-gateway";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("supports default GET options and closes the preload timer after success", async () => {
  vi.useFakeTimers();
  const invoke = vi.fn(async () => ({ resources: {} }));
  const gatewayFetch = createNativeAppGatewayFetch(invoke);
  await expect(gatewayFetch("/api/system/activity")).resolves.toEqual({ resources: {} });
  expect(invoke).toHaveBeenCalledWith({ url: "/api/system/activity" });
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects invalid preload input before IPC", async () => {
  const invoke = vi.fn();
  const gatewayFetch = createNativeAppGatewayFetch(invoke);
  await expect(gatewayFetch("/api/system/update")).rejects.toThrow("invalid app gateway request");
  await expect(gatewayFetch("/api/system/activity", { method: "POST" }))
    .rejects.toThrow("invalid app gateway request");
  expect(invoke).not.toHaveBeenCalled();
});

it.each([undefined, Infinity, 60_000])("bounds a hung IPC request to ten seconds (%s)", async (timeout) => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const gatewayFetch = createNativeAppGatewayFetch(() => new Promise(() => undefined));
  const result = expect(gatewayFetch("/api/system/activity", undefined, timeout))
    .rejects.toThrow(/^app gateway request failed$/);
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
