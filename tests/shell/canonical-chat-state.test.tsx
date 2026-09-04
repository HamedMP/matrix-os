// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import React, { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState.js";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));

function record(id: string, title: string, revision = 0) {
  return {
    chat: {
      id, ownerScope: { type: "personal" as const, ownerId: "owner_shell" }, title,
      lifecycle: "active" as const, attention: "none" as const, revision, messageCount: 1,
      currentSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
    },
  };
}

function detail(id: string, title: string, revision = 0) {
  return {
    record: record(id, title, revision),
    messages: [{
      id: `msg_${id}`, chatId: id, seq: 1, role: "assistant", state: "committed",
      parts: [{ type: "text", text: title }], createdAt: "2026-08-31T00:00:00.000Z",
    }],
    turns: [], runs: [], activities: [],
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canonical shell Chat state", () => {
  it("uses streamed invalidations without polling an active Run while attached", async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const streamResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    }), { headers: { "content-type": "text/event-stream" } });
    const runningRecord = {
      ...record("chat_stream", "Before"),
      activeRun: { runId: "run_stream", turnId: "cturn_stream", status: "running" as const },
    };
    let detailCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/chats/events")) return streamResponse;
      if (url.includes("/api/chats?")) return Response.json({ items: [runningRecord] });
      if (url.includes("/api/chats/chat_stream?")) {
        detailCalls += 1;
        return Response.json({
          ...detail("chat_stream", detailCalls === 1 ? "Before" : "After", detailCalls),
          record: { ...runningRecord, chat: { ...runningRecord.chat, revision: detailCalls } },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchFn);

    try {
      const { result } = renderHook(() => useCanonicalChatState(), {
        wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
      });
      await act(async () => {
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(result.current.messages[0]?.content).toBe("Before");

      streamController.enqueue(new TextEncoder().encode([
        'data: {"type":"chat.stream.attached"}',
        "",
        'id: 2',
        'data: {"type":"chat.event","event":{"cursor":2,"chatId":"chat_stream","revision":2,"eventType":"run.message","createdAt":"2026-09-04T00:00:00.000Z"}}',
        "",
        'id: 3',
        'data: {"type":"chat.event","event":{"cursor":3,"chatId":"chat_stream","revision":3,"eventType":"run.message","createdAt":"2026-09-04T00:00:01.000Z"}}',
        "",
        'id: 4',
        'data: {"type":"chat.event","event":{"cursor":4,"chatId":"chat_stream","revision":4,"eventType":"run.message","createdAt":"2026-09-04T00:00:02.000Z"}}',
        "",
        "",
      ].join("\n")));
      await act(async () => {
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(detailCalls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(199); });
      expect(detailCalls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(result.current.messages[0]?.content).toBe("After");
      expect(detailCalls).toBe(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
      expect(detailCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a two-second snapshot fallback while the event stream is still attaching", async () => {
    vi.useFakeTimers();
    const streamResponse = new Response(new ReadableStream<Uint8Array>(), {
      headers: { "content-type": "text/event-stream" },
    });
    const runningRecord = {
      ...record("chat_fallback", "Fallback"),
      activeRun: { runId: "run_fallback", turnId: "cturn_fallback", status: "running" as const },
    };
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/chats/events")) return streamResponse;
      if (url.includes("/api/chats?")) return Response.json({ items: [runningRecord] });
      if (url.includes("/api/chats/chat_fallback?")) {
        detailCalls += 1;
        return Response.json({ ...detail("chat_fallback", "Fallback", detailCalls), record: runningRecord });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    try {
      const { unmount } = renderHook(() => useCanonicalChatState());
      await act(async () => {
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(detailCalls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_900); });
      expect(detailCalls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(detailCalls).toBe(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an out-of-order detail response after switching chats", async () => {
    let resolveA: ((response: Response) => void) | undefined;
    const detailA = new Promise<Response>((resolve) => { resolveA = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [record("chat_a", "A"), record("chat_b", "B")] });
      if (url.includes("/api/chats/chat_a?")) return detailA;
      if (url.includes("/api/chats/chat_b?")) return Response.json(detail("chat_b", "B"));
      throw new Error("Unexpected request");
    }));

    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.sessionId).toBe("chat_a"));
    act(() => result.current.switchConversation("chat_b"));
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("B"));
    resolveA!(Response.json(detail("chat_a", "A")));
    await act(async () => { await Promise.resolve(); });

    expect(result.current.sessionId).toBe("chat_b");
    expect(result.current.messages[0]?.content).toBe("B");
  });

  it("keeps the newest same-chat detail revision when requests resolve out of order", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstDetail = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [record("chat_a", "A")] });
      if (url.includes("/api/chats/chat_a?")) {
        detailCalls += 1;
        return detailCalls === 1
          ? firstDetail
          : Response.json(detail("chat_a", "Newest", 2));
      }
      throw new Error("Unexpected request");
    }));

    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.sessionId).toBe("chat_a"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("Newest"));
    resolveFirst!(Response.json(detail("chat_a", "Stale", 1)));
    await act(async () => { await Promise.resolve(); });

    expect(result.current.messages[0]?.content).toBe("Newest");
  });

  it("does not expose an error from a superseded same-chat detail request", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstDetail = new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [record("chat_a", "A")] });
      if (url.includes("/api/chats/chat_a?")) {
        detailCalls += 1;
        return detailCalls === 1
          ? firstDetail
          : Response.json(detail("chat_a", "Current", 2));
      }
      throw new Error("Unexpected request");
    }));

    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.sessionId).toBe("chat_a"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("Current"));
    rejectFirst!(new Error("stale private failure"));
    await act(async () => { await Promise.resolve(); });

    expect(result.current.messages.map((message) => message.content))
      .toEqual(["Current"]);
  });

  it("does not regress a chat when a later refresh returns an older revision", async () => {
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [record("chat_a", "A", 2)] });
      if (url.includes("/api/chats/chat_a?")) {
        detailCalls += 1;
        return Response.json(detail("chat_a", detailCalls === 1 ? "Revision two" : "Revision one", detailCalls === 1 ? 2 : 1));
      }
      throw new Error("Unexpected request");
    }));

    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("Revision two"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(detailCalls).toBe(2));

    expect(result.current.messages[0]?.content).toBe("Revision two");
  });

  it("deletes uploaded attachment files when canonical turn admission fails", async () => {
    const existingRecord = record("chat_a", "A");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [existingRecord] });
      if (url.includes("/api/chats/chat_a?") && init?.method === undefined) {
        return Response.json(detail("chat_a", "A"));
      }
      if (url.includes("/api/files/blob?") && init?.method === "PUT") {
        const parsed = new URL(url);
        const path = parsed.searchParams.get("path")!;
        return Response.json({ ok: true, path, size: 5 });
      }
      if (url.endsWith("/api/chats/chat_a/turns")) {
        return Response.json({ error: "conflict" }, { status: 409 });
      }
      if (url.includes("/api/files/blob?") && init?.method === "DELETE") {
        const parsed = new URL(url);
        return Response.json({ ok: true, path: parsed.searchParams.get("path"), deleted: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("crypto", { randomUUID: () => "stable-id" });
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.sessionId).toBe("chat_a"));
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("A"));

    act(() => result.current.submitMessage("Review this", [{
      name: "notes.txt",
      type: "text/plain",
      data: "data:text/plain;base64,aGVsbG8=",
    }], {
      instanceId: "pi_default",
      model: "anthropic:claude-sonnet-5",
      interactionMode: "supervised",
      permissionMode: "default",
    }));

    await waitFor(() => expect(fetchFn.mock.calls.some(([url, init]) =>
      String(url).includes("/api/files/blob?") && (init as RequestInit | undefined)?.method === "DELETE"))
      .toBe(true));
    expect(result.current.messages.at(-1)?.content).toBe("Message could not be sent. Try again.");
  });

  it("waits for parallel uploads to settle before deleting partial successes", async () => {
    const existingRecord = record("chat_a", "A");
    let uploadCount = 0;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [existingRecord] });
      if (url.includes("/api/chats/chat_a?") && init?.method === undefined) {
        return Response.json(detail("chat_a", "A"));
      }
      if (url.includes("/api/files/blob?") && init?.method === "PUT") {
        uploadCount += 1;
        if (uploadCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const path = new URL(url).searchParams.get("path")!;
          return Response.json({ ok: true, path, size: 5 });
        }
        return Response.json({ error: "payload_too_large" }, { status: 413 });
      }
      if (url.includes("/api/files/blob?") && init?.method === "DELETE") {
        const path = new URL(url).searchParams.get("path")!;
        return Response.json({ ok: true, path, deleted: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("crypto", { randomUUID: vi.fn()
      .mockReturnValueOnce("first-id")
      .mockReturnValueOnce("second-id") });
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("A"));

    act(() => result.current.submitMessage("Review these", [{
      name: "first.txt", type: "text/plain", data: "data:text/plain;base64,aGVsbG8=",
    }, {
      name: "second.txt", type: "text/plain", data: "data:text/plain;base64,aGVsbG8=",
    }], {
      instanceId: "pi_default", model: "anthropic:claude-sonnet-5",
      interactionMode: "supervised", permissionMode: "default",
    }));

    await waitFor(() => expect(fetchFn.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "DELETE")).toHaveLength(1));
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/api/chats/chat_a/turns"))).toBe(false);
  });

  it("keeps uploaded files when admission outcome is ambiguous", async () => {
    const existingRecord = record("chat_a", "A");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [existingRecord] });
      if (url.includes("/api/chats/chat_a?") && init?.method === undefined) {
        return Response.json(detail("chat_a", "A"));
      }
      if (url.includes("/api/files/blob?") && init?.method === "PUT") {
        const path = new URL(url).searchParams.get("path")!;
        return Response.json({ ok: true, path, size: 5 });
      }
      if (url.endsWith("/api/chats/chat_a/turns")) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (url.includes("/api/files/blob?") && init?.method === "DELETE") {
        throw new Error("ambiguous admission must not delete the upload");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("crypto", { randomUUID: () => "stable-id" });
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("A"));

    act(() => result.current.submitMessage("Review this", [{
      name: "notes.txt", type: "text/plain", data: "data:text/plain;base64,aGVsbG8=",
    }], {
      instanceId: "pi_default", model: "anthropic:claude-sonnet-5",
      interactionMode: "supervised", permissionMode: "default",
    }));

    await waitFor(() => expect(result.current.messages.at(-1)?.content)
      .toBe("Message could not be sent. Try again."));
    expect(fetchFn.mock.calls.some(([, init]) =>
      (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("refreshes canonical list and active detail when the shell regains focus", async () => {
    let detailCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [record("chat_a", "A")] });
      if (url.includes("/api/chats/chat_a?")) {
        detailCalls += 1;
        return Response.json(detail("chat_a", detailCalls === 1 ? "Before" : "After"));
      }
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("Before"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("After"));

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/chats?"))).toHaveLength(2);
  });

  it("refuses a reused approval id when its carried run is no longer active", async () => {
    const currentRecord = {
      ...record("chat_a", "A"),
      activeRun: { runId: "run_current", turnId: "cturn_current", status: "waiting_for_approval" as const },
    };
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [currentRecord] });
      if (url.includes("/api/chats/chat_a?") && init?.method === undefined) {
        return Response.json({
          ...detail("chat_a", "A"),
          record: currentRecord,
          messages: [{
            id: "msg_old_approval", chatId: "chat_a", seq: 1, role: "system", state: "committed",
            runId: "run_previous", parts: [{
              type: "approval_request", approvalId: "approval_reused", title: "Old command",
              description: "Allow the old command?", risk: "medium", allowedDecisions: ["approve", "decline"],
            }], createdAt: "2026-08-31T00:00:00.000Z",
          }],
        });
      }
      if (url.includes("/approvals/")) throw new Error(`Wrong approval run: ${url}`);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchFn);
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages[0]?.metadata?.canonicalApproval)
      .toMatchObject({ runId: "run_previous", approvalId: "approval_reused" }));

    await act(async () => {
      await result.current.submitApproval?.("run_previous", "approval_reused", "approve");
    });

    expect(result.current.messages.at(-1)?.content)
      .toBe("The approval could not be submitted. Refresh and try again.");
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/approvals/"))).toBe(false);
    expect(fetchFn.mock.calls.some(([url]) =>
      String(url).includes("/runs/run_current/approvals/approval_reused"))).toBe(false);
  });
});
