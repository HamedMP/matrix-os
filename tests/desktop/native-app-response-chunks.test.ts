import { afterEach, expect, it, vi } from "vitest";
import { createNativeAppCapabilityRequester } from "@desktop/main/embeds/native-app-capabilities";
import { createNativeAppAiRequester, readBoundedJson } from "@desktop/main/embeds/native-app-bridge";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each([
  ["capability", "empty"], ["capability", "one-byte"],
  ["database", "empty"], ["database", "one-byte"],
  ["AI", "empty"], ["AI", "one-byte"],
] as const)("cancels and drains an excessive %s %s chunk response below the byte limit", async (transport, kind) => {
  vi.useFakeTimers();
  let count = 0;
  let release!: () => void;
  const cancelled = new Promise<void>(resolve => { release = resolve; });
  const cancel = vi.fn(() => cancelled);
  const fetchFn = vi.fn(async () => new Response(new ReadableStream({
    pull(controller) {
      if (count++ < 8192 + 5) controller.enqueue(kind === "empty" ? new Uint8Array() : new TextEncoder().encode(" "));
      else { controller.enqueue(new TextEncoder().encode(transport === "database" ? "[]" : transport === "AI" ? '{"text":"done"}' : "{}")); controller.close(); }
    }, cancel,
  })));
  const options = { getGatewayOrigin: () => "https://gateway.test", getToken: () => "synthetic", fetchFn };
  const request = () => transport === "database" ? fetchFn().then(readBoundedJson)
    : transport === "AI" ? createNativeAppAiRequester(options)("brain", { prompt: "hello" })
      : createNativeAppCapabilityRequester(options)("brain", { kind: "capabilities" });
  let settled = false;
  const pending = request().catch(error => error).finally(() => { settled = true; });
  // A bounded loop advances enough stream reads without advancing its deadline.
  for (let index = 0; index < 8300; index++) await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  release();
  expect(await pending).toBeInstanceOf(Error);
  expect(count).toBeLessThanOrEqual(8192 + 2);
  expect(vi.getTimerCount()).toBe(0);
});
