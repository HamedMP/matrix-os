// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanonicalInputSubmission } from "@desktop/renderer/src/features/chat/use-canonical-input-submission";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
afterEach(cleanup);
function setup(submitInput = vi.fn().mockResolvedValue({ requestId: "input_q", submission: "accepted" })) {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = { ...snapshot.runs[0]!, status: "waiting_for_input" as const };
  const detail = { ...snapshot, record: { chat: snapshot.chat, activeRun: { runId: run.id, turnId: run.turnId, status: "waiting_for_input" } }, runs: [run], activities: [{ id: "evt_input", chatId: run.chatId, runId: run.id,
    occurredAt: run.updatedAt, type: "input.requested", requestId: "input_q", title: "Choose a folder",
    questions: [{ questionId: "q1", header: "Folder", question: "Which folder?", allowOther: true, secret: false }] }] } as CanonicalChatDetailResponse;
  const client = { submitInput } as unknown as CanonicalChatClient;
  const detailRef = { current: detail as CanonicalChatDetailResponse | null };
  const scopeRef = { current: { active: true, client, projectId: null } };
  const loadDetail = vi.fn().mockResolvedValue(detail);
  const setError = vi.fn();
  const hook = renderHook(() => useCanonicalInputSubmission({ client, detailRef, scopeRef, loadDetail, setError }));
  return { hook, run, submitInput, detailRef, scopeRef, loadDetail, setError };
}
it("reuses the idempotency key after a transport failure", async () => {
  const state = setup(vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ requestId: "input_q", submission: "accepted" }));
  const answer = { structuredAnswers: { q1: ["Inbox"] } };
  await act(async () => { expect(await state.hook.result.current(state.run.id, "input_q", answer)).toBe(false); });
  await act(async () => { expect(await state.hook.result.current(state.run.id, "input_q", answer)).toBe(true); });
  expect(state.submitInput.mock.calls[0]![3].clientRequestId).toBe(state.submitInput.mock.calls[1]![3].clientRequestId);
});
it("prevents double submission and never reloads a different active chat after completion", async () => {
  let resolve!: (value: unknown) => void;
  const state = setup(vi.fn(() => new Promise(done => { resolve = done; })));
  const answer = { structuredAnswers: { q1: ["Inbox"] } };
  let first!: Promise<boolean>;
  await act(async () => {
    first = state.hook.result.current(state.run.id, "input_q", answer);
    expect(await state.hook.result.current(state.run.id, "input_q", answer)).toBe(false);
  });
  state.detailRef.current = null;
  await act(async () => { resolve({ requestId: "input_q", submission: "accepted" }); await first; });
  expect(state.submitInput).toHaveBeenCalledTimes(1);
  expect(state.loadDetail).not.toHaveBeenCalled();
  expect(state.setError).not.toHaveBeenCalled();
});
