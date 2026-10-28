import { afterEach, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { fakeGateway, baseInput } from "./hermes-test-gateway.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function start() {
  vi.useFakeTimers();
  const gateway = fakeGateway();
  const controller = new AbortController();
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
  const events: CanonicalProviderRunEvent[] = [];
  const done = (async () => {
    for await (const event of adapter.start({ ...baseInput, signal: controller.signal })) events.push(event);
  })();
  await vi.advanceTimersByTimeAsync(0);
  expect(gateway.requests.some(request => request.method === "prompt.submit")).toBe(true);
  return { gateway, controller, events, done };
}

it("keeps a silent busy Hermes turn alive beyond the old thirty-minute total deadline", async () => {
  const run = await start();
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(run.events.some(event => event.type === "run.completed")).toBe(false);
  expect(run.gateway.process.kill).not.toHaveBeenCalled();
  run.gateway.event("message.complete", { text: "long task completed", status: "complete" });
  await vi.advanceTimersByTimeAsync(0);
  await run.done;
  expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
});

it("still stops a silent Hermes turn after the old total deadline", async () => {
  const run = await start();
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  run.controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  await run.done;
  expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
  expect(run.gateway.requests.some(request => request.method === "session.interrupt")).toBe(true);
});
