import { afterEach, expect, it, vi } from "vitest";
import { createClaudeInputController } from "../../packages/gateway/src/chat/claude-input-control.js";

const TTL = 30 * 60_000;
const answer = (requestId: string) => ({ requestId, clientRequestId: `req_${requestId}`, structuredAnswers: { q0: ["Blue"] } });
function question(requestId: string) {
  return { type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion",
    input: { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Blue", description: "Ocean" }, { label: "Red", description: "Fire" }] }] } } };
}
function setup() {
  const write = vi.fn(async (_frame: string) => undefined);
  const emit = vi.fn();
  const signal = new AbortController();
  const controller = createClaudeInputController({ write, emit, signal: signal.signal });
  return { controller, write, emit, signal };
}
afterEach(() => vi.useRealTimers());

it("expires unanswered questions at an independent thirty-minute deadline and denies them", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  const { controller, write, emit } = setup();
  controller.handle(question("question"));
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "input.requested", expiresAt: "2026-10-21T00:30:00.000Z" }));
  await vi.advanceTimersByTimeAsync(TTL - 1);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "question", reason: "expired" });
  expect(JSON.parse(write.mock.calls[0]![0]).response.response).toMatchObject({ behavior: "deny" });
  await expect(controller.submit(answer("question"))).rejects.toThrow();
  expect(write).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["close", "abort", "native_cancel"])("cleans up questions on %s without late answers or expiry writes", async mode => {
  vi.useFakeTimers();
  const { controller, write, emit, signal } = setup();
  controller.handle(question("question"));
  const submission = controller.submit(answer("question"));
  if (mode === "close") controller.close();
  else if (mode === "abort") signal.abort();
  else controller.handle({ type: "control_cancel_request", request_id: "question" });
  await expect(submission).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(TTL);
  expect(write).not.toHaveBeenCalled();
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "question", reason: "cancelled" });
  expect(vi.getTimerCount()).toBe(0);
});

it("clears answered question timers and preserves duplicate-answer idempotency", async () => {
  vi.useFakeTimers();
  const { controller, write, emit } = setup();
  controller.handle(question("question"));
  await controller.submit(answer("question"));
  await controller.submit(answer("question"));
  await vi.advanceTimersByTimeAsync(TTL);
  expect(write).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "question", reason: "answered" });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not send a conflicting expiry denial while an on-time answer awaits stdin acceptance", async () => {
  vi.useFakeTimers();
  const { controller, write, emit } = setup();
  let accept: (() => void) | undefined;
  write.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
  controller.handle(question("question"));
  await vi.advanceTimersByTimeAsync(TTL - 1);
  const submission = controller.submit(answer("question"));
  const result = submission.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2);
  expect(write).toHaveBeenCalledOnce();
  accept!();
  await expect(result).resolves.toBeUndefined();
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "question", reason: "answered" });
});

it("does not replay an answer or send a denial after an uncertain answer transport failure", async () => {
  vi.useFakeTimers();
  const { controller, write, emit } = setup();
  write.mockRejectedValueOnce(new Error("not accepted"));
  controller.handle(question("question"));
  await vi.advanceTimersByTimeAsync(TTL - 10);
  await expect(controller.submit(answer("question"))).rejects.toThrow("not accepted");
  await expect(controller.submit(answer("question"))).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10);
  expect(write).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "question", reason: "cancelled" });
});

it("rejects expired answers even if the event loop has not delivered the expiry timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  const { controller, write, emit } = setup();
  controller.handle(question("question"));
  vi.setSystemTime(new Date("2026-10-21T00:30:00Z"));
  await expect(controller.submit(answer("question"))).rejects.toThrow();
  expect(write).toHaveBeenCalledOnce();
  expect(JSON.parse(write.mock.calls[0]![0]).response.response).toMatchObject({ behavior: "deny" });
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "question", reason: "expired" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["close", "abort", "native_cancel"])("never sends a second response after %s during an in-flight answer", async mode => {
  vi.useFakeTimers();
  const { controller, write, emit, signal } = setup();
  let accept: (() => void) | undefined;
  write.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
  controller.handle(question("question"));
  const result = controller.submit(answer("question")).then(() => false, () => true);
  await vi.advanceTimersByTimeAsync(0);
  if (mode === "close") controller.close();
  else if (mode === "abort") signal.abort();
  else controller.handle({ type: "control_cancel_request", request_id: "question" });
  accept!();
  await expect(result).resolves.toBe(true);
  await vi.advanceTimersByTimeAsync(TTL);
  expect(write).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "question", reason: "cancelled" });
  expect(vi.getTimerCount()).toBe(0);
});

it("caps distinct pending questions, allows duplicates at the cap and recovers slots on expiry", async () => {
  vi.useFakeTimers();
  const { controller } = setup();
  for (let index = 0; index < 16; index++) controller.handle(question(`question_${index}`));
  expect(() => controller.handle(question("question_0"))).not.toThrow();
  expect(() => controller.handle(question("overflow"))).toThrow("Input request limit exceeded");
  await vi.advanceTimersByTimeAsync(TTL);
  expect(() => controller.handle(question("new_question"))).not.toThrow();
  controller.close();
});
