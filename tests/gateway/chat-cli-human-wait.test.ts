import { expect, it, vi } from "vitest";
import { createCanonicalCliHumanWait } from "../../packages/gateway/src/chat/cli-human-wait.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

const question = (requestId: string): CanonicalProviderRunEvent => ({ type: "input.requested", requestId, title: "Question" });
const approval = (approvalId: string): CanonicalProviderRunEvent => ({ type: "approval.requested", approvalId, title: "Allow?", risk: "low", allowedDecisions: ["approve", "decline"] });

it("keeps approval and input identities separate and ignores unknown or duplicate resolutions", () => {
  const emit = vi.fn();
  const wait = createCanonicalCliHumanWait(emit);
  const control = { pause: vi.fn(), resume: vi.fn() };
  wait.attach(control);
  wait.emit(question("same")); wait.emit(question("same")); wait.emit(approval("same"));
  wait.emit({ type: "input.resolved", requestId: "unknown", reason: "cancelled" });
  wait.emit({ type: "input.resolved", requestId: "same", reason: "answered" });
  wait.emit({ type: "input.resolved", requestId: "same", reason: "answered" });
  expect(control.resume).not.toHaveBeenCalled();
  wait.emit({ type: "approval.resolved", approvalId: "same", decision: "cancel" });
  expect(control.resume).toHaveBeenCalledOnce();
  wait.emit({ type: "approval.resolved", approvalId: "same", decision: "cancel" });
  expect(control.resume).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenCalledTimes(8);
});

it("applies waits created before the process starts and drains on close", () => {
  const emit = vi.fn();
  const wait = createCanonicalCliHumanWait(emit);
  const control = { pause: vi.fn(), resume: vi.fn() };
  wait.emit(question("first"));
  wait.attach(control);
  expect(control.pause).toHaveBeenCalledOnce();
  wait.close();
  wait.emit({ type: "input.resolved", requestId: "first", reason: "cancelled" });
  wait.emit(question("late"));
  wait.attach(control);
  expect(control.resume).not.toHaveBeenCalled();
  expect(control.pause).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenCalledOnce();
});

it("caps human waits at the combined controller limit and reclaims resolved slots", () => {
  const wait = createCanonicalCliHumanWait(() => undefined);
  for (let index = 0; index < 64; index++) wait.emit(question(`question_${index}`));
  expect(() => wait.emit(question("question_0"))).not.toThrow();
  expect(() => wait.emit(approval("overflow"))).toThrow("Human request limit exceeded");
  wait.emit({ type: "input.resolved", requestId: "question_0", reason: "expired" });
  expect(() => wait.emit(approval("new"))).not.toThrow();
  wait.close();
});
