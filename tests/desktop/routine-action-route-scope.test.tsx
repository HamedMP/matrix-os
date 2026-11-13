// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
const mocks = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("../../desktop/src/renderer/src/features/chat/routine-action-confirmation", () => ({ openDesktopRoutineConfirmation: mocks.open }));
import { useCanonicalChatRouteController } from "../../desktop/src/renderer/src/features/chat/use-canonical-chat-route-controller";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const id = `rcact_${"a".repeat(32)}`;
function fixture() {
  const { snapshot } = createCanonicalChatFixture("approval_required"), run = snapshot.runs[0]!;
  const { project: _project, providerBinding: _binding, activeRun, ...chat } = snapshot.chat;
  const detail = { record: { chat, activeRun }, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs,
    activities: [...snapshot.activities, { id: "evt_routine_action", chatId: chat.id, runId: run.id, occurredAt: run.updatedAt,
      type: "approval.requested" as const, approvalId: id, title: "Allow routine pause?", risk: "medium" as const,
      allowedDecisions: ["approve" as const, "decline" as const], actionDigest: "d".repeat(64) }] };
  const client = { list: vi.fn(async () => ({ items: [detail.record] })), getDetail: vi.fn(async () => detail), submitApproval: vi.fn() } as unknown as CanonicalChatClient;
  return { client, detail, chatId: chat.id, runId: run.id };
}
it.each(["owner-b", "same-owner-new-session", "new-computer"])("retained actual Chat decision cannot open after authority changes: %s", async identity => {
  const f = fixture();
  const hook = renderHook(({ identity }) => useCanonicalChatRouteController({ client: f.client, active: true, projectId: null,
    initialChatId: f.chatId, admissionIdentity: identity }), { initialProps: { identity: "original" } });
  await waitFor(() => expect(hook.result.current.detail?.record.activeRun?.runId).toBe(f.runId));
  const oldSubmit = hook.result.current.submitApproval;
  hook.rerender({ identity });
  await waitFor(() => expect(hook.result.current.detail?.record.activeRun?.runId).toBe(f.runId));
  await act(async () => { expect(await oldSubmit(id, "approve")).toBe(false); });
  expect(mocks.open).not.toHaveBeenCalled(); expect(f.client.submitApproval).not.toHaveBeenCalled();
  await act(async () => { expect(await hook.result.current.submitApproval(id, "approve")).toBe(true); });
  expect(mocks.open).toHaveBeenCalledOnce();
});
it("retained actual Chat decision cannot open after unmount", async () => {
  const f = fixture();
  const hook = renderHook(() => useCanonicalChatRouteController({ client: f.client, active: true, projectId: null, initialChatId: f.chatId }));
  await waitFor(() => expect(hook.result.current.detail?.record.activeRun?.runId).toBe(f.runId));
  const oldSubmit = hook.result.current.submitApproval; hook.unmount();
  expect(await oldSubmit(id, "approve")).toBe(false);
  expect(mocks.open).not.toHaveBeenCalled(); expect(f.client.submitApproval).not.toHaveBeenCalled();
});
