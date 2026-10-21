// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderWorkflow } from "@matrix-os/contracts";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
import { useWorkflowPolling } from "../../packages/ui/src/agents-providers/use-workflow-polling";
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(expires = 60_000) {
  vi.useFakeTimers();
  const operation = { id: "wf", harnessInstanceId: "pi", kind: "login", state: "running", expiresAt: new Date(Date.now() + expires).toISOString() } as ProviderWorkflow;
  const get = vi.fn().mockRejectedValue(new ProviderWorkflowClientError());
  const input = { operation, harnessId: "pi", client: { get } as unknown as ProviderWorkflowClient, onUpdate: vi.fn(), onFailure: vi.fn() };
  return { ...renderHook(value => useWorkflowPolling(value), { initialProps: input }), input, get, operation };
}
it("recovers transient failures with bounded backoff and stops after success", async () => {
  const { get, input, operation } = setup();
  get.mockRejectedValueOnce(new ProviderWorkflowClientError()).mockResolvedValue({ ...operation, state: "succeeded" });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(input.onFailure).toHaveBeenCalledOnce();
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(input.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(get).toHaveBeenCalledTimes(2);
});
it.each(["forbidden", "rejected", "unauthorized"] as const)("does not retry %s", async reason => {
  const { get } = setup(); get.mockRejectedValue(new ProviderWorkflowClientError(reason));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(get).toHaveBeenCalledOnce();
});
it("never retries past expiry or fabricates a terminal receipt", async () => {
  const { get, input } = setup(5000);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(get).toHaveBeenCalledOnce(); expect(input.onUpdate).not.toHaveBeenCalled();
});
it("stops immediately on cancellation and drops an in-flight response", async () => {
  const { get, result, input, operation } = setup();
  let resolve!: (value: ProviderWorkflow) => void;
  get.mockImplementation(() => new Promise<ProviderWorkflow>(done => { resolve = done; }));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  act(() => result.current.stop());
  await act(async () => resolve({ ...operation, state: "succeeded" }));
  expect(input.onUpdate).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(60_000)); expect(get).toHaveBeenCalledOnce();
});
it("drops mismatched receipts without retry and stops on unmount", async () => {
  const { get, operation, unmount, input } = setup();
  get.mockResolvedValue({ ...operation, harnessInstanceId: "other" });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(get).toHaveBeenCalledOnce(); expect(input.onUpdate).not.toHaveBeenCalled();
  unmount(); expect(vi.getTimerCount()).toBe(0);
});

it("aborts the previous scope on harness change and does not publish its late receipt", async () => {
  const { get, input, operation, rerender } = setup();
  let resolve!: (value: ProviderWorkflow) => void;
  get.mockImplementation(() => new Promise<ProviderWorkflow>(done => { resolve = done; }));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  const oldSignal = get.mock.calls[0][1] as AbortSignal;
  rerender({ ...input, harnessId: "other" });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolve({ ...operation, state: "succeeded" }));
  expect(input.onUpdate).not.toHaveBeenCalled();
});
