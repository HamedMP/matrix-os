import { afterEach, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { fakeGateway, baseInput } from "./hermes-test-gateway.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it.each(["segments", "single_segment", "single_delta", "single_interim"])("truncates a long Hermes %s preview and still consumes later activity and completion", async mode => {
  vi.useFakeTimers();
  const gateway = fakeGateway();
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
  const events: CanonicalProviderRunEvent[] = [];
  const done = (async () => { for await (const event of adapter.start({ ...baseInput, signal: new AbortController().signal })) events.push(event); })();
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < (mode === "single_delta" || mode === "single_interim" ? 1 : 30); index++) {
    if (mode === "segments" || mode === "single_interim") gateway.event("message.interim", { text: mode === "segments" ? String(index % 10).repeat(4_000) : "x".repeat(120_000) });
    else gateway.event("message.delta", { text: "x".repeat(mode === "single_delta" ? 120_000 : 4_000) });
    await vi.advanceTimersByTimeAsync(0);
  }
  gateway.event("status.update", { kind: "planning" });
  gateway.event("message.complete", { text: mode === "segments" ? "final answer" : "x".repeat(120_000), status: "complete" });
  await vi.advanceTimersByTimeAsync(0);
  await done;
  expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.activity", kind: "plan", status: "completed" }));
  const text = events.flatMap(event => event.type === "assistant.delta" ? [event.delta] : []).join("");
  expect(text.match(/Output preview truncated/g)).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(96 * 1024 + 2);
  if (mode === "single_delta" || mode === "single_interim") expect(text.startsWith("x".repeat(1_000))).toBe(true);
});
