// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  CanonicalChatClient,
  CanonicalChatEventSource,
  CanonicalChatInvalidation,
} from "@desktop/renderer/src/lib/canonical-chat-client";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { AppError } from "@desktop/shared/app-error";
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
    acknowledgeCompletion: vi.fn(async () => globalRecord),
    create: vi.fn(),
    updateProject: vi.fn(async (_chatId, input) => ({
      ...globalRecord,
      chat: { ...globalRecord.chat, revision: input.baseRevision + 1 },
      ...(input.projectId === null ? {} : { projectId: input.projectId }),
    })),
    admitTurn: vi.fn(),
    queueTurn: vi.fn(),
    steerRun: vi.fn(),
    cancelQueuedTurn: vi.fn(),
    reorderQueuedTurns: vi.fn(),
    cancelRun: vi.fn(),
    submitApproval: vi.fn(),
    retryTurn: vi.fn(),
    ...overrides,
  } as CanonicalChatClient;
}

function eventHarness() {
  const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
  const eventSource: Pick<CanonicalChatEventSource, "subscribe"> = {
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    eventSource,
    listeners,
    emit(event: CanonicalChatInvalidation) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("canonical Chat route controller", () => {
  it("refreshes only the selected Chat from the shared event source and acknowledges its exact completion", async () => {
    const events = eventHarness();
    const runningA = {
      ...globalRecord,
      chat: { ...globalRecord.chat, id: "chat_parallel_a", title: "Parallel A" },
      activeRun: {
        runId: "run_parallel_a",
        turnId: "cturn_parallel_a",
        status: "running" as const,
      },
    };
    const completedB = {
      ...globalRecord,
      chat: { ...globalRecord.chat, id: "chat_parallel_b", title: "Parallel B", revision: 2 },
      latestSuccessfulCompletion: {
        runId: "run_parallel_b_completed",
        completedAt: "2026-08-29T01:02:00.000Z",
        unacknowledged: true,
      },
    };
    const acknowledgedB = {
      ...completedB,
      latestSuccessfulCompletion: {
        ...completedB.latestSuccessfulCompletion,
        unacknowledged: false,
      },
    };
    const getDetail = vi.fn(async (chatId: string) => ({
      ...detail,
      record: chatId === completedB.chat.id ? completedB : runningA,
    }));
    const acknowledgeCompletion = vi.fn(async () => acknowledgedB);
    const list = vi.fn(async () => ({ items: [runningA, completedB] }));
    const sharedClient = client({
      list,
      getDetail,
      acknowledgeCompletion,
    });
    const { result, unmount } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: completedB.chat.id,
      eventSource: events.eventSource,
    }));

    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(completedB.chat.id));
    await waitFor(() => expect(acknowledgeCompletion).toHaveBeenCalledWith(
      completedB.chat.id,
      completedB.latestSuccessfulCompletion.runId,
    ));
    expect(acknowledgeCompletion).toHaveBeenCalledTimes(1);
    const beforeBackgroundEvent = getDetail.mock.calls.length;

    act(() => events.emit({ type: "chat.changed", chatId: runningA.chat.id, cursor: 3 }));
    await Promise.resolve();
    expect(getDetail).toHaveBeenCalledTimes(beforeBackgroundEvent);

    act(() => events.emit({ type: "chat.changed", chatId: completedB.chat.id, cursor: 4 }));
    await waitFor(() => expect(getDetail.mock.calls.length).toBe(beforeBackgroundEvent + 1));
    expect(acknowledgeCompletion).toHaveBeenCalledTimes(1);

    const listCallsBeforeGap = list.mock.calls.length;
    act(() => events.emit({ type: "chat.full_refresh", cursor: 4 }));
    await waitFor(() => expect(list.mock.calls.length).toBe(listCallsBeforeGap + 1));

    unmount();
    expect(events.listeners.size).toBe(0);
  });

  it("coalesces a burst of selected Chat events into one in-flight and one pending detail refresh", async () => {
    const events = eventHarness();
    const firstRefresh = {
      ...detail,
      record: {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 1, title: "First refresh" },
      },
    };
    const secondRefresh = {
      ...detail,
      record: {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 2, title: "Second refresh" },
      },
    };
    let resolveFirstRefresh!: (value: typeof firstRefresh) => void;
    const deferredFirstRefresh = new Promise<typeof firstRefresh>((resolve) => {
      resolveFirstRefresh = resolve;
    });
    const getDetail = vi.fn(async () => detail);
    const sharedClient = client({ getDetail });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: globalRecord.chat.id,
      eventSource: events.eventSource,
    }));
    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(globalRecord.chat.id));
    expect(getDetail).toHaveBeenCalledTimes(1);
    getDetail.mockImplementationOnce(() => deferredFirstRefresh);
    getDetail.mockResolvedValueOnce(secondRefresh);

    act(() => {
      for (const cursor of [1, 2, 3]) {
        events.emit({ type: "chat.changed", chatId: globalRecord.chat.id, cursor });
      }
    });
    expect(getDetail).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirstRefresh(firstRefresh);
      await deferredFirstRefresh;
    });
    await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.detail?.record.chat.title).toBe("Second refresh"));
  });

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

  it("retries a failed canonical turn and installs the admitted Run in the active detail", async () => {
    const failedRecord = {
      ...globalRecord,
      chat: { ...globalRecord.chat, revision: 3 },
    };
    const failedRun = {
      id: "run_failed",
      chatId: globalRecord.chat.id,
      turnId: "cturn_failed",
      attempt: 1,
      driverKind: "codex" as const,
      instanceId: "codex_default",
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      status: "failed" as const,
      outcome: "failed" as const,
      historyBoundarySeq: 1,
      capabilitySnapshot: {
        revision: "catalog_1",
        rootChat: true,
        attachments: ["file" as const],
        resources: ["file" as const],
        tools: [],
        approvals: true,
        userInput: true,
        resume: true,
        cancellation: true,
        worktrees: "optional" as const,
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:01:00.000Z",
      completedAt: "2026-08-26T00:01:00.000Z",
    };
    const admittedRun = { ...failedRun, id: "run_retry", attempt: 2, status: "accepted" as const, outcome: undefined, completedAt: undefined };
    const admittedRecord = {
      ...failedRecord,
      chat: { ...failedRecord.chat, revision: 4 },
      activeRun: { runId: admittedRun.id, turnId: admittedRun.turnId, status: "accepted" as const },
    };
    const retryTurn = vi.fn(async () => ({ admission: "accepted" as const, record: admittedRecord, run: admittedRun }));
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [failedRecord] })),
      getDetail: vi.fn(async () => ({ ...detail, record: failedRecord, runs: [failedRun] })),
      retryTurn,
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: globalRecord.chat.id,
    }));
    await waitFor(() => expect(result.current.detail?.runs).toHaveLength(1));

    await act(async () => {
      await result.current.retryTurn("cturn_failed");
    });

    expect(retryTurn).toHaveBeenCalledWith(globalRecord.chat.id, "cturn_failed", {
      clientRequestId: expect.any(String),
      baseRevision: 3,
    });
    expect(result.current.detail?.record.activeRun?.runId).toBe("run_retry");
    expect(result.current.detail?.runs.map((run) => run.id)).toEqual(["run_failed", "run_retry"]);
  });

  it("submits an approval decision for the active Run and refreshes its durable state", async () => {
    const waitingRecord = {
      ...globalRecord,
      activeRun: { runId: "run_waiting", turnId: "cturn_waiting", status: "waiting_for_approval" as const },
    };
    const waitingDetail = { ...detail, record: waitingRecord };
    const resolvedDetail = { ...detail, record: globalRecord };
    const getDetail = vi.fn()
      .mockResolvedValueOnce(waitingDetail)
      .mockResolvedValueOnce(resolvedDetail);
    const submitApproval = vi.fn(async () => ({
      approvalId: "appr_command",
      decision: "approve" as const,
      submission: "accepted" as const,
    }));
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [waitingRecord] })),
      getDetail,
      submitApproval,
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: globalRecord.chat.id,
    }));
    await waitFor(() => expect(result.current.detail?.record.activeRun?.runId).toBe("run_waiting"));

    await act(async () => {
      await result.current.submitApproval("appr_command", "approve");
    });

    expect(submitApproval).toHaveBeenCalledWith("chat_global", "run_waiting", "appr_command", {
      clientRequestId: expect.any(String),
      decision: "approve",
    });
    expect(getDetail).toHaveBeenCalledTimes(2);
    expect(result.current.detail?.record.activeRun).toBeUndefined();
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

  it("does not let a delayed old acknowledgement overwrite a newer successful completion", async () => {
    vi.useFakeTimers();
    try {
      const oldCompletion = {
        runId: "run_completed_old",
        completedAt: "2026-08-26T00:01:00.000Z",
        unacknowledged: true,
      };
      const initiallyRunningRecord = {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 5 },
        activeRun: { runId: "run_newer_running", turnId: "cturn_newer", status: "running" as const },
        latestSuccessfulCompletion: oldCompletion,
      };
      const newestCompletionRecord = {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 6 },
        latestSuccessfulCompletion: {
          runId: "run_completed_newest",
          completedAt: "2026-08-26T00:02:00.000Z",
          unacknowledged: true,
        },
      };
      const delayedOldAcknowledgement = {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 6 },
        latestSuccessfulCompletion: { ...oldCompletion, unacknowledged: false },
      };
      let resolveAcknowledgement!: (record: typeof delayedOldAcknowledgement) => void;
      const acknowledgeCompletion = vi.fn(() => new Promise<typeof delayedOldAcknowledgement>((resolve) => {
        resolveAcknowledgement = resolve;
      }));
      const getDetail = vi.fn()
        .mockResolvedValueOnce({ ...detail, record: initiallyRunningRecord })
        .mockResolvedValue({ ...detail, record: newestCompletionRecord });
      const sharedClient = client({
        list: vi.fn(async () => ({ items: [initiallyRunningRecord] })),
        getDetail,
        acknowledgeCompletion,
      });
      const { result } = renderHook(() => useCanonicalChatRouteController({
        client: sharedClient,
        projectId: null,
        active: true,
        initialChatId: globalRecord.chat.id,
      }));

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(acknowledgeCompletion).toHaveBeenCalledWith(
        globalRecord.chat.id,
        oldCompletion.runId,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(acknowledgeCompletion.mock.calls).toEqual([
        [globalRecord.chat.id, oldCompletion.runId],
        [globalRecord.chat.id, newestCompletionRecord.latestSuccessfulCompletion.runId],
      ]);
      expect(result.current.detail?.record.latestSuccessfulCompletion)
        .toEqual(newestCompletionRecord.latestSuccessfulCompletion);

      await act(async () => {
        resolveAcknowledgement(delayedOldAcknowledgement);
        await Promise.resolve();
      });
      expect(result.current.detail?.record.latestSuccessfulCompletion)
        .toEqual(newestCompletionRecord.latestSuccessfulCompletion);
    } finally {
      vi.useRealTimers();
    }
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

  it("retries after one transient detail failure and converges on the completed Run", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const runningRecord = {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 1 },
        activeRun: { runId: "run_retry", turnId: "turn_retry", status: "running" as const },
      };
      const completedRecord = {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 3 },
      };
      const getDetail = vi.fn()
        .mockResolvedValueOnce({ ...detail, record: runningRecord })
        .mockRejectedValueOnce(new TypeError("temporary schema mismatch"))
        .mockResolvedValueOnce({ ...detail, record: completedRecord });
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

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.detail?.record.chat.revision).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(getDetail).toHaveBeenCalledTimes(3);
      expect(result.current.detail?.record.chat.revision).toBe(3);
      expect(result.current.detail?.record.activeRun).toBeUndefined();
      expect(result.current.error).toBeNull();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries a transient initial detail failure without requiring the Chat to be reselected", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const completedRecord = {
        ...globalRecord,
        chat: { ...globalRecord.chat, revision: 3 },
      };
      const getDetail = vi.fn()
        .mockRejectedValueOnce(new TypeError("temporary gateway failure"))
        .mockResolvedValueOnce({ ...detail, record: completedRecord });
      const sharedClient = client({
        list: vi.fn(async () => ({ items: [completedRecord] })),
        getDetail,
      });
      const { result } = renderHook(() => useCanonicalChatRouteController({
        client: sharedClient,
        projectId: null,
        active: true,
        initialChatId: globalRecord.chat.id,
      }));

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(getDetail).toHaveBeenCalledTimes(1);
      expect(result.current.detail).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(getDetail).toHaveBeenCalledTimes(2);
      expect(result.current.detail?.record.chat.revision).toBe(3);
      expect(result.current.error).toBeNull();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects an older revision while an active Run continues polling", async () => {
    vi.useFakeTimers();
    try {
      const recordAt = (revision: number, activeRun = true) => ({
        ...globalRecord,
        chat: { ...globalRecord.chat, revision },
        ...(activeRun ? {
          activeRun: { runId: "run_revision", turnId: "turn_revision", status: "running" as const },
        } : {}),
      });
      const getDetail = vi.fn()
        .mockResolvedValueOnce({ ...detail, record: recordAt(5) })
        .mockResolvedValueOnce({ ...detail, record: recordAt(4) })
        .mockResolvedValueOnce({ ...detail, record: recordAt(6, false) });
      const sharedClient = client({
        list: vi.fn(async () => ({ items: [recordAt(5)] })),
        getDetail,
      });
      const { result } = renderHook(() => useCanonicalChatRouteController({
        client: sharedClient,
        projectId: null,
        active: true,
        initialChatId: globalRecord.chat.id,
      }));

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.detail?.record.chat.revision).toBe(5);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(result.current.detail?.record.chat.revision).toBe(5);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(result.current.detail?.record.chat.revision).toBe(6);
      expect(getDetail).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling an admitted Project Run until the completed assistant message is visible", async () => {
    const projectRecord = {
      ...globalRecord,
      projectId: "project_1",
      chat: { ...globalRecord.chat, id: "chat_project_continuation", title: "Project continuation" },
    };
    const activeRun = {
      runId: "run_project_continuation",
      turnId: "turn_project_continuation",
      status: "running" as const,
    };
    const admittedRecord = {
      ...projectRecord,
      chat: { ...projectRecord.chat, revision: 1, messageCount: 1 },
      activeRun,
    };
    const message = {
      id: "message_project_continuation",
      chatId: projectRecord.chat.id,
      seq: 1,
      role: "user" as const,
      state: "committed" as const,
      turnId: activeRun.turnId,
      parts: [{ type: "text" as const, text: "Continue in this Project" }],
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    const turn = {
      id: activeRun.turnId,
      chatId: projectRecord.chat.id,
      clientRequestId: "request_project_continuation",
      baseMessageSeq: 0,
      inputMessageId: message.id,
      status: "accepted" as const,
      createdAt: "2026-08-26T00:00:01.000Z",
      updatedAt: "2026-08-26T00:00:01.000Z",
    };
    const run = {
      id: activeRun.runId,
      chatId: projectRecord.chat.id,
      turnId: turn.id,
      attempt: 1,
      status: "running" as const,
      driverKind: "codex" as const,
      instanceId: "codex_default",
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      historyBoundarySeq: 0,
      capabilitySnapshot: {
        revision: "catalog_1",
        rootChat: true,
        attachments: true,
        resources: true,
        tools: true,
        approvals: true,
        userInput: false,
        resume: true,
        cancellation: true,
        worktrees: false,
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
      createdAt: "2026-08-26T00:00:01.000Z",
      updatedAt: "2026-08-26T00:00:01.000Z",
    };
    const runningDetail = {
      record: admittedRecord,
      messages: [message],
      turns: [turn],
      runs: [run],
      activities: [],
    };
    const assistantMessage = {
      id: "message_project_continuation_assistant",
      chatId: projectRecord.chat.id,
      seq: 2,
      role: "assistant" as const,
      state: "committed" as const,
      turnId: turn.id,
      runId: run.id,
      parts: [{ type: "text" as const, text: "Project continuation completed" }],
      createdAt: "2026-08-26T00:00:02.000Z",
    };
    const completedDetail = {
      ...runningDetail,
      record: {
        ...projectRecord,
        chat: { ...projectRecord.chat, revision: 2, messageCount: 2 },
      },
      messages: [message, assistantMessage],
      runs: [{ ...run, status: "completed" as const, outcome: "completed" as const }],
    };
    const getDetail = vi.fn()
      .mockResolvedValueOnce({ ...detail, record: projectRecord })
      .mockResolvedValueOnce(runningDetail)
      .mockResolvedValueOnce(completedDetail);
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [projectRecord] })),
      getDetail,
      admitTurn: vi.fn(async () => ({
        record: admittedRecord,
        message,
        turn,
        run,
        admission: "accepted" as const,
      })),
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: "project_1",
      active: true,
      initialChatId: projectRecord.chat.id,
    }));
    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(projectRecord.chat.id));

    vi.useFakeTimers();
    try {
      await act(async () => {
        await result.current.submitTurn({
          parts: [{ type: "text", text: "Continue in this Project" }],
          selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
          interactionMode: "default",
          permissionMode: "supervised",
        }, "Project continuation");
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });

      expect(getDetail).toHaveBeenCalledTimes(3);
      expect(result.current.detail?.messages).toContainEqual(assistantMessage);
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

  it("includes a safe failure reason while recording only the diagnostic category", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedClient = client({
      list: vi.fn(async () => ({ items: [] })),
      create: vi.fn(async () => globalRecord),
      admitTurn: vi.fn(async () => { throw new AppError("offline", { cause: new TypeError("provider secret detail") }); }),
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

    expect(result.current.error).toBe(
      "The message could not be sent. Reason: Can't reach Matrix OS. Check your connection.",
    );
    expect(warn).toHaveBeenCalledWith("[canonical-chat] submit failed:", "offline");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("provider secret detail"));
    warn.mockRestore();
  });

  it("steers the exact active Run and manages the durable Queue with current revisions", async () => {
    const runningRecord = {
      ...globalRecord,
      chat: { ...globalRecord.chat, revision: 5 },
      activeRun: {
        runId: "run_queue_controller",
        turnId: "cturn_queue_controller",
        status: "running" as const,
      },
    };
    const queuedTurn = (id: string, position: number, text: string) => ({
      id,
      chatId: globalRecord.chat.id,
      clientRequestId: `req_${id}`,
      position,
      parts: [{ type: "text" as const, text }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      createdAt: "2026-08-31T01:00:00.000Z",
      updatedAt: "2026-08-31T01:00:00.000Z",
    });
    const activeRunRecord = {
      id: runningRecord.activeRun.runId,
      chatId: globalRecord.chat.id,
      turnId: runningRecord.activeRun.turnId,
      attempt: 1,
      driverKind: "codex" as const,
      instanceId: "codex_default",
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      status: "running" as const,
      historyBoundarySeq: 0,
      capabilitySnapshot: {
        revision: "catalog_controller_queue",
        rootChat: true,
        attachments: ["file" as const],
        resources: ["file" as const],
        tools: [],
        approvals: true,
        userInput: true,
        resume: true,
        cancellation: true,
        steering: "same_run" as const,
        worktrees: "optional" as const,
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
      createdAt: "2026-08-31T01:00:00.000Z",
      updatedAt: "2026-08-31T01:00:00.000Z",
    };
    const first = queuedTurn("qturn_controller_1", 1, "First queued turn");
    const second = queuedTurn("qturn_controller_2", 2, "Second queued turn");
    const third = queuedTurn("qturn_controller_3", 3, "Third queued turn");
    const detailAt = (revision: number, queuedTurns: ReturnType<typeof queuedTurn>[]) => ({
      ...detail,
      record: { ...runningRecord, chat: { ...runningRecord.chat, revision } },
      runs: [activeRunRecord],
      queuedTurns,
    });
    const getDetail = vi.fn(async () => detailAt(5, [first, second]));
    const steerRun = vi.fn(async () => ({
      runId: runningRecord.activeRun.runId,
      turnId: runningRecord.activeRun.turnId,
      message: {
        id: "msg_controller_steer",
        chatId: globalRecord.chat.id,
        seq: 1,
        role: "user" as const,
        state: "committed" as const,
        turnId: runningRecord.activeRun.turnId,
        runId: runningRecord.activeRun.runId,
        parts: [{ type: "text" as const, text: "Steer this run" }],
        createdAt: "2026-08-31T01:00:01.000Z",
      },
      steering: "accepted" as const,
    }));
    const queueTurn = vi.fn(async () => ({ queuedTurn: third, queueDepth: 3 }));
    const reorderQueuedTurns = vi.fn(async () => ({ queuedTurns: [second, first, third] }));
    const cancelQueuedTurn = vi.fn(async () => ({
      queuedTurnId: first.id,
      queueDepth: 2,
      cancellation: "cancelled" as const,
    }));
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [runningRecord] })),
      getDetail,
      steerRun,
      queueTurn,
      reorderQueuedTurns,
      cancelQueuedTurn,
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: globalRecord.chat.id,
    }));
    await waitFor(() => expect(result.current.detail?.record.chat.revision).toBe(5));

    await act(async () => {
      await result.current.steerActiveRun([{ type: "text", text: "Steer this run" }]);
    });
    expect(steerRun).toHaveBeenCalledWith(globalRecord.chat.id, runningRecord.activeRun.runId, {
      clientRequestId: expect.any(String),
      expectedTurnId: runningRecord.activeRun.turnId,
      parts: [{ type: "text", text: "Steer this run" }],
    });

    await act(async () => {
      await result.current.queueTurn({
        parts: third.parts,
        selection: third.selection,
        interactionMode: third.interactionMode,
        permissionMode: third.permissionMode,
      });
    });
    expect(queueTurn).toHaveBeenCalledWith(globalRecord.chat.id, expect.objectContaining({
      baseRevision: 7,
      parts: third.parts,
    }));

    await act(async () => {
      await result.current.reorderQueuedTurns([second.id, first.id, third.id]);
    });
    expect(reorderQueuedTurns).toHaveBeenCalledWith(globalRecord.chat.id, {
      clientRequestId: expect.any(String),
      baseRevision: 8,
      queuedTurnIds: [second.id, first.id, third.id],
    });

    await act(async () => {
      await result.current.cancelQueuedTurn(first.id);
    });
    expect(cancelQueuedTurn).toHaveBeenCalledWith(globalRecord.chat.id, first.id, {
      clientRequestId: expect.any(String),
      baseRevision: 9,
    });
    expect(getDetail).toHaveBeenCalledTimes(1);
    expect(result.current.detail?.record.chat.revision).toBe(10);
    expect(result.current.detail?.queuedTurns?.map((turn) => turn.id)).toEqual([
      second.id,
      third.id,
    ]);
  });

  it("fails closed when the active Run snapshot does not support same-run steering", async () => {
    const activeRecord = {
      ...globalRecord,
      activeRun: {
        runId: "run_without_steering",
        turnId: "cturn_without_steering",
        status: "running" as const,
      },
    };
    const steerRun = vi.fn();
    const sharedClient = client({
      list: vi.fn(async () => ({ items: [activeRecord] })),
      getDetail: vi.fn(async () => ({
        ...detail,
        record: activeRecord,
        runs: [{
          id: activeRecord.activeRun.runId,
          capabilitySnapshot: { steering: "none" },
        } as never],
      })),
      steerRun,
    });
    const { result } = renderHook(() => useCanonicalChatRouteController({
      client: sharedClient,
      projectId: null,
      active: true,
      initialChatId: globalRecord.chat.id,
    }));
    await waitFor(() => expect(result.current.detail?.record.activeRun).toBeTruthy());

    let response: unknown;
    await act(async () => {
      response = await result.current.steerActiveRun([{ type: "text", text: "Do not send" }]);
    });

    expect(response).toBeNull();
    expect(steerRun).not.toHaveBeenCalled();
  });
});
