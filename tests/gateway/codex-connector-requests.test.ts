import { describe, expect, it, vi } from "vitest";
import { createConnectorRequests } from "../../packages/gateway/src/coding-agents/codex-connector-requests.mjs";

function harness() {
  let time = 0;
  const send = vi.fn();
  const persist = vi.fn(async () => {});
  const requests = createConnectorRequests({ send, persist, safeText: (value: string) => value,
    scope: () => ({ threadId: "thread", turnId: "turn" }), now: () => time });
  return { requests, send, persist, tick: () => { time = 300_001; } };
}
const raw = { id: 42, method: "mcpServer/elicitation/request", params: { threadId: "thread", turnId: "turn", serverName: "connector", mode: "openai/form", message: "Allow once?", requestedSchema: null } };

describe("connector request lifetime", () => {
  it("resolves completed-turn requests without replying on the closed native turn", async () => {
    const h = harness();
    await h.requests.handle(raw);
    await h.requests.expire(true, false);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.persist.mock.calls.at(-1)?.[0]).toMatchObject({ type: "matrix.codex.user_input.resolved" });
  });
  it("does not cancel an outstanding request when the same frame is replayed", async () => {
    const h = harness();
    await h.requests.handle(raw);
    await h.requests.handle(raw);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledTimes(1);
  });
  it("cancels expired requests and persists resolution without answer content", async () => {
    const h = harness();
    await h.requests.handle(raw);
    expect(h.send).not.toHaveBeenCalled();
    h.tick();
    await h.requests.expire();
    expect(h.send).toHaveBeenCalledWith({ id: 42, result: { action: "cancel", content: null, _meta: null } });
    expect(h.persist.mock.calls.at(-1)?.[0]).toMatchObject({ type: "matrix.codex.user_input.resolved" });
    await h.requests.expire();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it("answers unknown requests, but does not answer notifications", async () => {
    const h = harness();
    expect(await h.requests.handle({ id: 0, method: "future/request", params: {} })).toBe(true);
    expect(h.send).toHaveBeenCalledWith({ id: 0, error: { code: -32601, message: "This request is not supported." } });
    expect(await h.requests.handle({ method: "future/notification" })).toBe(false);
  });
  it("fails requests for another thread closed and drains outstanding consent", async () => {
    const h = harness();
    await h.requests.handle({ ...raw, params: { ...raw.params, threadId: "other" } });
    expect(h.persist).not.toHaveBeenCalled();
    await h.requests.handle(raw);
    await h.requests.expire(true);
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});
