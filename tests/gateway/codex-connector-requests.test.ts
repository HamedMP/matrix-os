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
  it("validates answers, rejects expired/replayed controls, and keeps unexpired requests", async () => {
    const h = harness();
    expect(h.requests.answer("missing", {})).toBeUndefined();
    await h.requests.handle(raw);
    const request = h.persist.mock.calls[0]![0] as { requestId: string; connectorActionId: string };
    await h.requests.expire();
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.requests.answer(request.requestId, {})).toBe(false);
    expect(h.requests.answer(request.requestId, { [request.connectorActionId]: ["Allow once"] })).toBe(true);
    expect(h.send).toHaveBeenCalledWith({ id: 42, result: { action: "accept", content: {}, _meta: null } });
    expect(h.requests.answer(request.requestId, {})).toBeUndefined();
    await h.requests.handle({ ...raw, id: 43 });
    const expired = h.persist.mock.calls[1]![0] as { requestId: string };
    h.tick();
    expect(h.requests.answer(expired.requestId, {})).toBe(false);
  });
  it("fails malformed forms closed and cancels if persistence fails", async () => {
    const h = harness();
    expect(await h.requests.handle({ id: null, method: "bad" })).toBe(false);
    await h.requests.handle({ ...raw, params: { ...raw.params, requestedSchema: { type: "array" } } });
    expect(h.send).toHaveBeenCalledWith({ id: 42, error: { code: -32602, message: "This connector form is not supported." } });
    h.persist.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(h.requests.handle(raw)).rejects.toThrow("disk unavailable");
    expect(h.send).toHaveBeenLastCalledWith({ id: 42, result: { action: "cancel", content: null, _meta: null } });
    await h.requests.handle(raw);
    expect(h.persist).toHaveBeenCalledTimes(2);
  });
  it("persists explicit URL authorization and enforces the request cap", async () => {
    const h = harness();
    await h.requests.handle({ ...raw, params: { ...raw.params, mode: "url", url: "https://connect.example.com/authorize", elicitationId: "auth" } });
    expect(h.persist.mock.calls[0]?.[0]).toMatchObject({ connectorUrl: "https://connect.example.com/authorize" });
    for (let id = 100; id < 120; id++) await h.requests.handle({ ...raw, id });
    expect(h.persist).toHaveBeenCalledTimes(20);
    expect(h.send).toHaveBeenLastCalledWith({ id: 119, result: { action: "cancel", content: null, _meta: null } });
  });
  it.each([undefined, "another-turn"])("rejects absent/mismatched active turns (%s)", async (turnId) => {
    const send = vi.fn();
    const requests = createConnectorRequests({ send, persist: vi.fn(), safeText: (value: string) => value,
      scope: () => ({ threadId: "thread", turnId }) });
    await requests.handle(raw);
    expect(send).toHaveBeenCalledWith({ id: 42, result: { action: "cancel", content: null, _meta: null } });
  });
  it("does not misclassify non-Error programming failures as unsupported forms", async () => {
    const requests = createConnectorRequests({ send: vi.fn(), persist: vi.fn(), safeText: () => { throw "unexpected"; },
      scope: () => ({ threadId: "thread", turnId: "turn" }) });
    await expect(requests.handle(raw)).rejects.toBe("unexpected");
  });
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
