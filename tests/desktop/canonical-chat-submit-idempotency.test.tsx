// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { createCanonicalChatClient, type CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { CanonicalCreateChatRequestSchema, CanonicalCreateChatTurnRequestSchema,
  type CanonicalChatRecord, type CanonicalChatTurnAdmissionResponse } from "@matrix-os/contracts";
import { AppError } from "@desktop/shared/app-error";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const record = { chat: { id: "chat_retry", ownerScope: { type: "personal" as const, ownerId: "owner_test" },
  title: "Retry", lifecycle: "active" as const, attention: "none" as const, revision: 1, messageCount: 0,
  createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" } };
const detail = { record, messages: [], turns: [], runs: [], activities: [] };
const input = { parts: [{ type: "text" as const, text: "Send once" }],
  selection: { instanceId: "codex_test", model: "test" }, interactionMode: "default", permissionMode: "supervised" };

describe("Electron admission retry identity", () => {
  it("publishes the entire recovered snapshot when the Run already finished without a stream event", async () => {
    const { snapshot } = createCanonicalChatFixture("completed");
    const { project, providerBinding, activeRun: _activeRun, ...chat } = snapshot.chat;
    const recovered = { record: { chat, providerBinding, projectId: project.projectId },
      messages: [...snapshot.messages, { ...snapshot.messages[0], id: "msg_reply", role: "assistant" as const, seq: 2,
        parts: [{ type: "text" as const, text: "Completed before acknowledgement" }] }],
      turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
    const initial = { ...recovered, messages: [], turns: [], runs: [], activities: [],
      record: { ...recovered.record, chat: { ...chat, revision: 0, messageCount: 0 } } };
    const client = { list: vi.fn(async () => ({ items: [initial.record] })), getDetail: vi.fn(async () => initial),
      admitTurn: vi.fn(async () => ({ record: recovered.record, message: recovered.messages[0], turn: recovered.turns[0],
        run: recovered.runs[0], admission: "already_accepted", recoveredDetail: recovered })) } as unknown as CanonicalChatClient;
    const accepted = vi.fn();
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true, initialChatId: chat.id }));
    try {
      await act(async () => {});
      await act(async () => { await hook.result.current.submitTurn(input, "Recovered", null, accepted); });
      expect(hook.result.current.detail?.messages.at(-1)?.parts).toEqual([{ type: "text", text: "Completed before acknowledgement" }]);
      expect(hook.result.current.detail?.record.activeRun).toBeUndefined();
      expect(accepted).toHaveBeenCalledOnce();
    } finally { hook.unmount(); }
  });
  it("keeps the original request ID when readback is inconclusive and the user retries unchanged text", async () => {
    const admitTurn = vi.fn().mockRejectedValue(new AppError("timeout"));
    const client = { list: vi.fn(async () => ({ items: [record] })), getDetail: vi.fn(async () => detail), admitTurn } as unknown as CanonicalChatClient;
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true, initialChatId: record.chat.id }));
    try {
      await act(async () => {});
      await act(async () => { await hook.result.current.submitTurn(input, "Retry"); });
      const original = admitTurn.mock.calls[0][1].clientRequestId;
      await act(async () => { await hook.result.current.submitTurn(input, "Retry"); });
      expect(admitTurn.mock.calls[1][1].clientRequestId).toBe(original);
      await act(async () => { await hook.result.current.submitTurn({ ...input, parts: [{ type: "text", text: "Different" }] }, "Retry"); });
      expect(admitTurn.mock.calls[2][1].clientRequestId).not.toBe(original);
    } finally { hook.unmount(); }
  });
  it.each([
    { projectId: null, explicitNewChat: false }, { projectId: null, explicitNewChat: true },
    { projectId: "project_retry", explicitNewChat: false }, { projectId: "project_retry", explicitNewChat: true },
  ])("respects New Chat after an unknown first send with offline readback (project: $projectId, New Chat: $explicitNewChat)", async ({ projectId, explicitNewChat }) => {
    const { snapshot } = createCanonicalChatFixture("running");
    const created: Array<{ key: string; record: CanonicalChatRecord }> = [];
    const admissions: Array<{ key: string; response: CanonicalChatTurnAdmissionResponse }> = [];
    const createKeys: string[] = [];
    const admissionKeys: string[] = [];
    let loseAcknowledgement = true;
    let readbackAvailable = false;
    const client = createCanonicalChatClient({
      get: vi.fn(async (path: string) => {
        const url = new URL(path, "https://matrix.test");
        if (url.pathname === "/api/chats") return { items: [] };
        if (url.pathname.includes("/turn-admissions/")) throw new AppError("offline");
        if (!readbackAvailable) throw new AppError("offline");
        const admitted = admissions.find(row => url.pathname === `/api/chats/${row.response.record.chat.id}`)?.response;
        if (!admitted) throw new AppError("offline");
        return { record: admitted.record, messages: [admitted.message], turns: [admitted.turn], runs: [admitted.run], activities: [] };
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        const url = new URL(path, "https://matrix.test");
        if (url.pathname === "/api/chats") {
          const request = CanonicalCreateChatRequestSchema.parse(body);
          createKeys.push(request.clientRequestId);
          const existing = created.find(row => row.key === request.clientRequestId);
          if (existing) return existing.record;
          const { activeRun: _activeRun, providerBinding: _binding, project: _project, ...chat } = snapshot.chat;
          const record: CanonicalChatRecord = { chat: { ...chat,
            id: `chat_created_${created.length + 1}`, revision: 0, messageCount: 0 } };
          if (request.projectId) record.projectId = request.projectId;
          created.push({ key: request.clientRequestId, record });
          return record;
        }
        const request = CanonicalCreateChatTurnRequestSchema.parse(body);
        const target = created.find(row => url.pathname === `/api/chats/${row.record.chat.id}/turns`);
        if (!target) throw new Error("Unexpected test admission target");
        admissionKeys.push(request.clientRequestId);
        const key = `${target.record.chat.id}:${request.clientRequestId}`;
        let accepted = admissions.find(row => row.key === key)?.response;
        if (!accepted) {
          const suffix = created.length;
          const turnId = `cturn_created_${suffix}`;
          const messageId = `msg_created_${suffix}`;
          const runId = `run_created_${suffix}`;
          accepted = { record: { ...target.record, chat: { ...target.record.chat, revision: 1, messageCount: 1 },
            activeRun: { runId, turnId, status: "running" } },
            message: { ...snapshot.messages[0], id: messageId, chatId: target.record.chat.id, turnId, parts: request.parts },
            turn: { ...snapshot.turns[0], id: turnId, chatId: target.record.chat.id, inputMessageId: messageId, clientRequestId: request.clientRequestId },
            run: { ...snapshot.runs[0], id: runId, chatId: target.record.chat.id, turnId,
              instanceId: request.selection.instanceId, selection: request.selection }, admission: "accepted" };
          admissions.push({ key, response: accepted });
        }
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new AppError("timeout"); }
        return accepted;
      }), patch: vi.fn(), delete: vi.fn(),
    });
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId, active: true, autoSelectFirst: false }));
    try {
      await act(async () => {});
      await act(async () => { expect(await hook.result.current.submitTurn(input, "Same draft")).toBeNull(); });
      expect(hook.result.current.activeChatId).toBeNull();
      expect(admissions).toHaveLength(1);
      if (explicitNewChat) act(() => hook.result.current.startNewChat());
      readbackAvailable = true;
      await act(async () => { expect(await hook.result.current.submitTurn(input, "Same draft")).not.toBeNull(); });
      expect(hook.result.current.activeChatId).toBe(explicitNewChat ? "chat_created_2" : "chat_created_1");
      expect(created).toHaveLength(explicitNewChat ? 2 : 1);
      expect(admissions).toHaveLength(explicitNewChat ? 2 : 1);
      expect(createKeys).toHaveLength(explicitNewChat ? 2 : 1);
      expect(new Set(createKeys).size).toBe(explicitNewChat ? 2 : 1);
      expect(admissionKeys[1] === admissionKeys[0]).toBe(!explicitNewChat);
    } finally { hook.unmount(); }
  });

});
