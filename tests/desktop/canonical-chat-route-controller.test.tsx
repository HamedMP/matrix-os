// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { describe, expect, it, vi } from "vitest";

const globalRecord = {
  chat: {
    id: "chat_global",
    ownerScope: { type: "personal" as const, ownerId: "owner_1" },
    title: "Global chat",
    lifecycle: "active" as const,
    attention: "none" as const,
    revision: 0,
    messageCount: 0,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
};

const detail = {
  record: globalRecord,
  messages: [],
  turns: [],
  runs: [],
  activities: [],
};

function client(overrides: Partial<CanonicalChatClient> = {}): CanonicalChatClient {
  return {
    list: vi.fn(async () => ({ items: [globalRecord] })),
    search: vi.fn(async () => ({ items: [globalRecord] })),
    getDetail: vi.fn(async () => detail),
    create: vi.fn(),
    updateProject: vi.fn(async (_chatId, input) => ({
      ...globalRecord,
      chat: { ...globalRecord.chat, revision: input.baseRevision + 1 },
      ...(input.projectId === null ? {} : { projectId: input.projectId }),
    })),
    admitTurn: vi.fn(),
    cancelRun: vi.fn(),
    retryTurn: vi.fn(),
    ...overrides,
  } as CanonicalChatClient;
}

describe("canonical Chat route controller", () => {
  it("loads Global and Project entry points through the same scoped controller", async () => {
    const sharedClient = client();
    const { result, rerender } = renderHook(
      ({ projectId }) => useCanonicalChatRouteController({
        client: sharedClient,
        projectId,
        active: true,
      }),
      { initialProps: { projectId: null as string | null } },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(sharedClient.list).toHaveBeenLastCalledWith({ projectId: null, limit: 100 });
    expect(result.current.activeChatId).toBe("chat_global");

    rerender({ projectId: "project_1" });
    await waitFor(() => expect(sharedClient.list).toHaveBeenLastCalledWith({
      projectId: "project_1",
      limit: 100,
    }));
  });

  it("moves one Chat identity with its confirmed revision and refreshes the target scope", async () => {
    const updateProject = vi.fn(async (_chatId: string, input: { baseRevision: number; projectId: string | null }) => ({
      ...globalRecord,
      chat: { ...globalRecord.chat, revision: input.baseRevision + 1 },
      ...(input.projectId === null ? {} : { projectId: input.projectId }),
    }));
    const sharedClient = client({ updateProject });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
    }));
    await waitFor(() => expect(result.current.activeChatId).toBe("chat_global"));

    await act(async () => {
      await result.current.moveProject("project_1");
    });

    expect(updateProject).toHaveBeenCalledWith("chat_global", {
      baseRevision: 0,
      projectId: "project_1",
    });
    expect(result.current.detail?.record.chat.id).toBe("chat_global");
    expect(result.current.detail?.record.projectId).toBe("project_1");
  });

  it("uses one scoped search identity instead of a second Project index", async () => {
    const search = vi.fn(async () => ({ items: [globalRecord] }));
    const sharedClient = client({ search });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: "project_1",
      active: true,
    }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.search("release plan");
    });

    expect(search).toHaveBeenCalledWith("release plan", {
      projectId: "project_1",
      limit: 100,
    });
  });

  it("opens the requested Chat identity after a cross-route move", async () => {
    const targetRecord = {
      ...globalRecord,
      chat: { ...globalRecord.chat, id: "chat_moved", title: "Moved chat" },
    };
    const getDetail = vi.fn(async (chatId: string) => ({
      ...detail,
      record: chatId === "chat_moved" ? targetRecord : globalRecord,
    }));
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [globalRecord, targetRecord] })),
      getDetail,
    });

    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: "chat_moved",
    }));

    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe("chat_moved"));
    expect(getDetail).toHaveBeenCalledWith("chat_moved", { limit: 200 });
  });

  it("does not reload when the retained tab reflects an internally selected Chat", async () => {
    const sharedClient = client();
    const { result, rerender } = renderHook(
      ({ initialChatId }) => useCanonicalChatRouteController({
        client: sharedClient,
        projectId: null,
        active: true,
        initialChatId,
        autoSelectFirst: false,
      }),
      { initialProps: { initialChatId: null as string | null } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.selectChat(globalRecord.chat.id));
    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(globalRecord.chat.id));
    rerender({ initialChatId: globalRecord.chat.id });

    expect(sharedClient.list).toHaveBeenCalledTimes(1);
    expect(sharedClient.getDetail).toHaveBeenCalledTimes(1);
    expect(result.current.detail?.record.chat.id).toBe(globalRecord.chat.id);
  });

  it("finishes the scoped list load when an initial Chat detail loads concurrently", async () => {
    let resolveList!: (value: { items: typeof globalRecord[] }) => void;
    const list = vi.fn(() => new Promise<{ items: typeof globalRecord[] }>((resolve) => {
      resolveList = resolve;
    }));
    const sharedClient = client({ list });

    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: "project_1",
      active: true,
      initialChatId: "chat_global",
    }));

    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe("chat_global"));
    expect(result.current.status).toBe("loading");

    await act(async () => {
      resolveList({ items: [globalRecord] });
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("polls active Runs so persisted activity and assistant deltas reach the shared surface", async () => {
    const runningRecord = {
      ...globalRecord,
      activeRun: { runId: "run_streaming", turnId: "turn_streaming", status: "running" as const },
    };
    const firstDetail = {
      ...detail,
      record: runningRecord,
      runs: [{
        id: "run_streaming",
        chatId: globalRecord.chat.id,
        turnId: "turn_streaming",
        attempt: 1,
        status: "running" as const,
        providerInstanceId: "codex_default",
        createdAt: "2026-08-26T00:00:01.000Z",
      }],
    };
    const streamedDetail = {
      ...firstDetail,
      activities: [{
        id: "activity_delta_1",
        runId: "run_streaming",
        sequence: 1,
        type: "assistant.delta" as const,
        occurredAt: "2026-08-26T00:00:02.000Z",
        payload: { messageId: "assistant_streaming", delta: "partial answer" },
      }],
    };
    const getDetail = vi.fn()
      .mockResolvedValueOnce(firstDetail)
      .mockResolvedValue(streamedDetail);
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [runningRecord] })),
      getDetail,
    });

    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: globalRecord.chat.id,
    }));

    await waitFor(() => expect(result.current.detail?.record.activeRun?.status).toBe("running"));
    await waitFor(() => expect(result.current.detail?.activities).toEqual(streamedDetail.activities), {
      timeout: 2_000,
    });
    expect(getDetail).toHaveBeenCalledTimes(2);
  });

  it("refreshes an active Run quickly enough for conversational streaming", async () => {
    vi.useFakeTimers();
    try {
      const runningRecord = {
        ...globalRecord,
        activeRun: { runId: "run_streaming", turnId: "turn_streaming", status: "running" as const },
      };
      const runningDetail = { ...detail, record: runningRecord };
      const getDetail = vi.fn(async () => runningDetail);
      const sharedClient = client({
        list: vi.fn(async () => ({ items: [runningRecord] })),
        getDetail,
      });
      renderHook(() => useCanonicalChatRouteController({
        client: sharedClient,
        projectId: null,
        active: true,
        initialChatId: globalRecord.chat.id,
      }));

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(getDetail).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(getDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits the first Project turn before opening its detail so the optimistic message cannot be replaced by an empty Chat", async () => {
    const projectRecord = {
      ...globalRecord,
      projectId: "project_1",
      chat: { ...globalRecord.chat, id: "chat_project_new", title: "First project message" },
    };
    const admittedRecord = {
      ...projectRecord,
      chat: {
        ...projectRecord.chat,
        revision: 2,
        messageCount: 1,
        lastMessagePreview: "First project message",
      },
      activeRun: { runId: "run_project_1", turnId: "turn_project_1", status: "queued" as const },
    };
    const message = {
      id: "message_project_1",
      chatId: projectRecord.chat.id,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "First project message" }],
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    const turn = {
      id: "turn_project_1",
      chatId: projectRecord.chat.id,
      messageId: message.id,
      sequence: 1,
      status: "queued" as const,
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    const run = {
      id: "run_project_1",
      chatId: projectRecord.chat.id,
      turnId: turn.id,
      attempt: 1,
      status: "queued" as const,
      providerInstanceId: "codex_default",
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    let resolveAdmission!: (value: unknown) => void;
    const admitTurn = vi.fn(() => new Promise((resolve) => { resolveAdmission = resolve; }));
    const getDetail = vi.fn(async () => ({
      record: projectRecord,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    }));
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [] })),
      create: vi.fn(async () => projectRecord),
      admitTurn,
      getDetail,
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: "project_1",
      active: true,
    }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let submission!: Promise<unknown>;
    act(() => {
      submission = result.current.submitTurn({
        parts: [{ type: "text", text: "First project message" }],
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
      }, "First project message");
    });
    await waitFor(() => expect(admitTurn).toHaveBeenCalledTimes(1));
    expect(getDetail).not.toHaveBeenCalled();

    await act(async () => {
      resolveAdmission({ record: admittedRecord, message, turn, run });
      await submission;
    });
    expect(result.current.detail?.messages).toEqual([message]);
    expect(result.current.detail?.runs).toEqual([run]);
    expect(result.current.activeChatId).toBe(projectRecord.chat.id);
  });

  it("creates a Global draft inside the Project selected before its first Turn", async () => {
    const projectRecord = {
      ...globalRecord,
      projectId: "project_1",
      chat: { ...globalRecord.chat, id: "chat_project_draft", title: "Inspect workspace" },
    };
    const message = {
      id: "message_project_draft",
      chatId: projectRecord.chat.id,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Inspect workspace" }],
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    const turn = {
      id: "turn_project_draft",
      chatId: projectRecord.chat.id,
      messageId: message.id,
      sequence: 1,
      status: "queued" as const,
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    const run = {
      id: "run_project_draft",
      chatId: projectRecord.chat.id,
      turnId: turn.id,
      attempt: 1,
      status: "queued" as const,
      providerInstanceId: "codex_default",
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    const create = vi.fn(async () => projectRecord);
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [] })),
      create,
      admitTurn: vi.fn(async () => ({ record: projectRecord, message, turn, run })),
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
    }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.submitTurn({
        parts: [{ type: "text", text: "Inspect workspace" }],
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
      }, "Inspect workspace", "project_1");
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project_1" }));
  });

  it("ignores a Turn admitted by the previous runtime scope", async () => {
    const createdRecord = {
      ...globalRecord,
      chat: { ...globalRecord.chat, id: "chat_previous_runtime" },
    };
    let resolveAdmission!: (value: Awaited<ReturnType<CanonicalChatClient["admitTurn"]>>) => void;
    const previousClient = client({
      list: vi.fn(async () => ({ items: [] })),
      create: vi.fn(async () => createdRecord),
      admitTurn: vi.fn(() => new Promise((resolve) => { resolveAdmission = resolve; })),
    });
    const nextClient = client({ list: vi.fn(async () => ({ items: [] })) });
    const { result, rerender } = renderHook(
      ({ scopedClient }) => useCanonicalChatRouteController({
        client: scopedClient,
        projectId: null,
        active: true,
        autoSelectFirst: false,
      }),
      { initialProps: { scopedClient: previousClient } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let submission!: Promise<unknown>;
    act(() => {
      submission = result.current.submitTurn({
        parts: [{ type: "text", text: "Old runtime message" }],
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
      }, "Old runtime message");
    });
    await waitFor(() => expect(previousClient.admitTurn).toHaveBeenCalledTimes(1));

    rerender({ scopedClient: nextClient });
    await waitFor(() => expect(nextClient.list).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveAdmission({
        record: createdRecord,
        message: {
          id: "message_old_runtime",
          chatId: createdRecord.chat.id,
          role: "user",
          parts: [{ type: "text", text: "Old runtime message" }],
          createdAt: "2026-08-26T00:00:01.000Z",
        },
        turn: {
          id: "turn_old_runtime",
          chatId: createdRecord.chat.id,
          messageId: "message_old_runtime",
          sequence: 1,
          status: "queued",
          createdAt: "2026-08-26T00:00:01.000Z",
        },
        run: {
          id: "run_old_runtime",
          chatId: createdRecord.chat.id,
          turnId: "turn_old_runtime",
          attempt: 1,
          status: "queued",
          providerInstanceId: "codex_default",
          createdAt: "2026-08-26T00:00:01.000Z",
        },
      });
      await submission;
    });

    expect(result.current.activeChatId).toBeNull();
    expect(result.current.detail).toBeNull();
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("keeps the user error generic while recording a diagnostic category", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedClient = client({
      list: vi.fn(async () => ({ items: [] })),
      create: vi.fn(async () => globalRecord),
      admitTurn: vi.fn(async () => { throw new TypeError("provider secret detail"); }),
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: failedClient,
      projectId: null,
      active: true,
      autoSelectFirst: false,
    }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.submitTurn({
        parts: [{ type: "text", text: "Fail safely" }],
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
      }, "Fail safely");
    });

    expect(result.current.error).toBe("The message could not be sent. Try again.");
    expect(warn).toHaveBeenCalledWith("[canonical-chat] submit failed:", "TypeError");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("provider secret detail"));
    warn.mockRestore();
  });
});
