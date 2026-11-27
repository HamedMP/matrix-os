import { afterEach, expect, it, vi } from "vitest";
import { withCapabilityLookupTimeout } from "../../packages/gateway/src/server/capability-lookup-timeout.js";

afterEach(() => vi.useRealTimers());

it("returns the owner lookup result and clears its deadline after settlement", async () => {
  vi.useFakeTimers();
  const result = ["gmail", "github"];
  await expect(withCapabilityLookupTimeout(async () => result)).resolves.toBe(result);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves lookup failures and clears the outstanding timer", async () => {
  vi.useFakeTimers();
  const error = new Error("lookup unavailable");
  await expect(withCapabilityLookupTimeout(async () => { throw error; })).rejects.toBe(error);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a stalled inventory lookup to ten seconds", async () => {
  vi.useFakeTimers();
  const request = withCapabilityLookupTimeout(() => new Promise<never>(() => undefined));
  const rejection = expect(request).rejects.toThrow("capability lookup timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});
