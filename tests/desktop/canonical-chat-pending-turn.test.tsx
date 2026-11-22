// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { withPendingCanonicalTurn } from "@matrix-os/ui";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

// ENG-522: Electron Desktop showed a sent follow-up only after admission
// returned (0.9-4.8 s). The controller now exposes it as a pending turn.

it("exposes a sent follow-up as a pending turn until admission settles, on success and on rejection", async () => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { project, providerBinding, activeRun: _activeRun, ...chat } = snapshot.chat;
  const detail = { record: { chat, providerBinding, projectId: project.projectId }, messages: snapshot.messages,
    turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
  let release!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const client = { list: vi.fn(async () => ({ items: [detail.record] })), getDetail: vi.fn(async () => detail),
    admitTurn: vi.fn(() => new Promise((resolve, reject) => { release = resolve; fail = reject; })) } as unknown as CanonicalChatClient;
  const input = { parts: [{ type: "text" as const, text: "Follow up please" }],
    selection: { instanceId: "codex_test", model: "test" }, interactionMode: "default", permissionMode: "supervised" };
  const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true, initialChatId: chat.id }));
  try {
    await act(async () => {});
    let sending!: Promise<unknown>;
    await act(async () => { sending = hook.result.current.submitTurn(input, "Follow up"); });
    const pending = hook.result.current.pendingTurn;
    expect(pending).toMatchObject({ chatId: chat.id, parts: input.parts });
    const shown = withPendingCanonicalTurn(hook.result.current.detail!, pending);
    expect(shown.messages.at(-1)?.parts).toEqual(input.parts);
    await act(async () => { fail(new Error("offline")); await sending; });
    expect(hook.result.current.pendingTurn).toBeNull();

    await act(async () => { sending = hook.result.current.submitTurn({ ...input, parts: [{ type: "text", text: "Again" }] }, "Again"); });
    expect(hook.result.current.pendingTurn?.parts).toEqual([{ type: "text", text: "Again" }]);
    await act(async () => { release({ record: detail.record, message: detail.messages[0], turn: detail.turns[0], run: detail.runs[0], admission: "accepted" }); await sending; });
    expect(hook.result.current.pendingTurn).toBeNull();
  } finally { hook.unmount(); }
});
