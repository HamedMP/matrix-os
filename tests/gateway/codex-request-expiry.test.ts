import { expect, it, vi } from "vitest";
import { cancel, expireNativeRequests } from "../../packages/gateway/src/coding-agents/codex-request-expiry.mjs";

it("cancels expired command approvals and resolves the UI request without authorizing anything", async () => {
  const approvals = new Map([["appr_one", { nativeRequestId: 1, expiresAt: 5 }], ["appr_two", { nativeRequestId: 2, expiresAt: 50 }]]);
  const inputs = new Map([["req_one", { nativeRequestId: 3, expiresAt: 5, correlationId: "corr_one" }]]);
  const send = vi.fn(); const persist = vi.fn(async () => {});
  await expireNativeRequests({ approvals, inputs, send, persist, now: 10 });
  expect(send.mock.calls).toEqual([[{ id: 1, result: { decision: "cancel" } }], [{ id: 3, result: { answers: {} } }]]);
  expect(persist).toHaveBeenCalledWith({ type: "matrix.codex.approval.resolved", approvalId: "appr_one", decision: "cancel" });
  expect(persist).toHaveBeenCalledWith({ type: "matrix.codex.user_input.resolved", requestId: "req_one", correlationId: "corr_one" });
  expect(approvals.size).toBe(1);
  expect(inputs.size).toBe(0);
});

it("keeps live input requests and isolates closed cancellation transports", async () => {
  const inputs = new Map([["req_live", { nativeRequestId: 1, expiresAt: 50, correlationId: "corr_live" }]]);
  const send = vi.fn();
  await expireNativeRequests({ approvals: new Map(), inputs, send, persist: vi.fn(), now: 10 });
  expect(inputs.size).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(() => cancel(() => { throw new Error("closed"); }, {})).not.toThrow();
  expect(() => cancel(() => { throw "unexpected"; }, {})).toThrow("unexpected");
});

it("clears completed-turn requests without writing to an already exiting provider", async () => {
  const approvals = new Map([["appr_one", { nativeRequestId: 1, expiresAt: 50 }]]);
  const inputs = new Map([["req_one", { nativeRequestId: 2, expiresAt: 50, correlationId: "corr_one" }]]);
  const send = vi.fn(); const persist = vi.fn(async () => {});
  await expireNativeRequests({ approvals, inputs, send, persist, now: 10, all: true, reply: false });
  expect(send).not.toHaveBeenCalled();
  expect(persist).toHaveBeenCalledTimes(2);
  expect(approvals.size + inputs.size).toBe(0);
});
