import { describe, expect, it, vi } from "vitest";
import { createHermesSelectedRouteGate } from "../../packages/gateway/src/chat/hermes-selected-route.js";

const selected = { provider: "openai-codex", model: "gpt-6-astra" };
const info = (sessionId: string, payload: unknown = selected) => ({
  type: "session.info", session_id: sessionId, payload,
});

describe("Hermes actual session route", () => {
  it("ignores lazy, malformed and unrelated notifications until the selected session is confirmed", async () => {
    const gate = createHermesSelectedRouteGate(selected);
    gate.setSession("current", false);
    let confirmed = false;
    const ready = gate.ready(new AbortController().signal, 1000).then(() => { confirmed = true; });
    gate.observe(info("other"));
    gate.observe(info("current", { ...selected, lazy: true }));
    gate.observe(info("current", { provider: selected.provider }));
    await Promise.resolve();
    expect(confirmed).toBe(false);
    gate.observe(info("current"));
    await ready;
    expect(confirmed).toBe(true);
  });

  it("rejects a route change after initial native confirmation", async () => {
    const gate = createHermesSelectedRouteGate(selected);
    gate.setSession("current", false);
    gate.observe(info("current"));
    await gate.ready(new AbortController().signal, 100);
    expect(() => gate.observe(info("current", { provider: "anthropic", model: "claude-fable-5" })))
      .toThrow("The selected native route was not confirmed");
  });

  it("requires fresh confirmation after restoring a durable session", async () => {
    const gate = createHermesSelectedRouteGate(selected);
    gate.observe(info("current", { provider: "anthropic", model: "claude-fable-5" }));
    gate.setSession("current", true);
    const ready = gate.ready(new AbortController().signal, 1000);
    gate.observe(info("current"));
    await expect(ready).resolves.toBeUndefined();
  });

  it("fails closed on missing route metadata and releases its deadline", async () => {
    vi.useFakeTimers();
    try {
      const gate = createHermesSelectedRouteGate(selected);
      gate.setSession("current", false);
      const rejected = expect(gate.ready(new AbortController().signal, 100)).rejects.toThrow("The selected native route was not confirmed");
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("releases its deadline when the run is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const gate = createHermesSelectedRouteGate(selected);
      gate.setSession("current", false);
      const controller = new AbortController();
      const rejected = expect(gate.ready(controller.signal, 100)).rejects.toThrow("The selected native route was not confirmed");
      controller.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
