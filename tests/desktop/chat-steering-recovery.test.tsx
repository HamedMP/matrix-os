// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalChatRunSteeringResponse } from "@matrix-os/contracts";
import type { CanonicalChatClient, CanonicalChatInvalidation } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function running(): CanonicalChatDetailResponse {
  const snapshot = createCanonicalChatFixture("running").snapshot;
  const { activeRun, project, providerBinding, ...chat } = snapshot.chat;
  return { record: { chat, activeRun, projectId: project?.projectId, providerBinding },
    messages: snapshot.messages, turns: snapshot.turns, activities: snapshot.activities,
    runs: snapshot.runs.map(run => ({ ...run, capabilitySnapshot: { ...run.capabilitySnapshot, steering: "same_run" } })),
    queuedTurns: [{ id: "cqturn_correction", chatId: chat.id, clientRequestId: "req_correction", position: 1,
      parts: [{ type: "text", text: "Use the new instructions" }], selection: snapshot.runs[0]!.selection,
      interactionMode: "default", permissionMode: "supervised", createdAt: chat.createdAt, updatedAt: chat.updatedAt }] };
}
function harness() {
  let snapshot = running();
  const initial = snapshot;
  const pending = deferred<CanonicalChatRunSteeringResponse>();
  let notify: ((event: CanonicalChatInvalidation) => void) | undefined;
  const client = { list: vi.fn(async () => ({ items: [snapshot.record] })),
    getDetail: vi.fn(async () => snapshot), steerRun: vi.fn(() => pending.promise),
    steerQueuedTurn: vi.fn(() => pending.promise), updateReadState: vi.fn(async () => snapshot.record),
  } as unknown as CanonicalChatClient;
  const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true,
    initialChatId: initial.record.chat.id, externalNavigation: true,
    eventSource: { subscribe(listener) { notify = listener; return { dispose() { notify = undefined; } }; } },
  }));
  const receipt: CanonicalChatRunSteeringResponse = { runId: initial.record.activeRun!.runId,
    turnId: initial.record.activeRun!.turnId, steering: "accepted", message: {
      id: "msg_correction", chatId: initial.record.chat.id, seq: 2, role: "user", state: "committed",
      runId: initial.record.activeRun!.runId, turnId: initial.record.activeRun!.turnId,
      parts: [{ type: "text", text: "Use the new instructions" }], createdAt: "2026-11-21T00:00:01Z",
    } };
  return { hook, client, pending, initial, receipt,
    publish(next: CanonicalChatDetailResponse) {
      snapshot = next;
      notify?.({ type: "chat.changed", chatId: next.record.chat.id, cursor: next.record.chat.revision,
        revision: next.record.chat.revision, eventType: "run.steer_requested" });
    },
    setSnapshot(next: CanonicalChatDetailResponse) { snapshot = next; },
  };
}

it.each(["direct", "queued"])("keeps an accepted %s correction visible when a newer snapshot arrives before its acknowledgement", async kind => {
  const h = harness();
  await waitFor(() => expect(h.hook.result.current.detail?.record.activeRun).toBeDefined());
  let sending!: Promise<unknown>;
  act(() => { sending = kind === "direct" ? h.hook.result.current.steerActiveRun(h.receipt.message.parts)
    : h.hook.result.current.steerQueuedTurn("cqturn_correction"); });
  // The durable requested event increments revision before provider delivery settles.
  act(() => h.publish({ ...h.initial, record: { ...h.initial.record,
    chat: { ...h.initial.record.chat, revision: h.initial.record.chat.revision + 1, title: "Newer title" } } }));
  await waitFor(() => expect(h.hook.result.current.detail?.record.chat.title).toBe("Newer title"));
  await act(async () => { h.pending.resolve(h.receipt); await sending; });
  expect(h.hook.result.current.detail?.messages.map(message => message.id)).toContain("msg_correction");
  expect(h.hook.result.current.detail?.record.chat.title).toBe("Newer title");
  if (kind === "queued") expect(h.hook.result.current.detail?.queuedTurns).toEqual([]);
});

it.each(["direct", "queued"])("does not reload the old Chat after a late %s steering failure", async kind => {
  const h = harness();
  await waitFor(() => expect(h.hook.result.current.detail?.record.activeRun).toBeDefined());
  let sending!: Promise<unknown>;
  act(() => { sending = kind === "direct" ? h.hook.result.current.steerActiveRun(h.receipt.message.parts)
    : h.hook.result.current.steerQueuedTurn("cqturn_correction"); });
  const other = { ...h.initial, record: { ...h.initial.record, chat: { ...h.initial.record.chat, id: "chat_other" } } };
  h.setSnapshot(other);
  await act(async () => { await h.hook.result.current.selectChat("chat_other"); });
  await waitFor(() => expect(h.hook.result.current.detail?.record.chat.id).toBe("chat_other"));
  const reads = vi.mocked(h.client.getDetail).mock.calls.length;
  await act(async () => { h.pending.reject(new Error("lost response")); await sending; });
  expect(h.client.getDetail).toHaveBeenCalledTimes(reads);
  expect(h.hook.result.current.detail?.record.chat.id).toBe("chat_other");
  expect(h.hook.result.current.error).toBeNull();
});
