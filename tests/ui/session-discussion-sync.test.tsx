// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionDiscussion } from "../../packages/ui/src/collaboration/useSessionDiscussion";
import type { CollaborationApi } from "../../packages/ui/src/collaboration/ChatCollaboratorsDialog";

const scope = {
  id: "10000000-0000-4000-8000-000000000001", ownerId: "user_owner",
  kind: "chat" as const, resourceId: "chat_shared", membershipMode: "direct" as const,
  lifecycle: "shared" as const, revision: "1", authEpoch: "1", authorityGeneration: "1",
  role: "editor" as const,
  capabilities: { read: true, discuss: true, manageMembers: false, requestAi: true,
    observeTerminal: false, controlTerminal: false, stopTerminal: false },
};
const note = (sequence: number) => ({
  id: `note-${sequence}`, scopeId: scope.id, sequence: String(sequence),
  actor: { actorId: "user_peer", displayName: "Peer" }, text: `Note ${sequence}`,
  createdAt: "2026-11-23T10:00:00.000Z",
});
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
function useDiscussion(api: CollaborationApi, actorId = "user_owner") {
  return useSessionDiscussion({ api, scope, actorId, runtimeId: "owner-vps", open: true, storage });
}
afterEach(cleanup);

describe("Discussion synchronization", () => {
  it("renders a successful posted note despite gaps occupied by AI messages", async () => {
    const api = { baseUrl: "https://app.matrix-os.com", get: vi.fn(async () => ({
      messages: [note(3)], latestSequence: "3",
    })), post: vi.fn(async () => note(8)), delete: vi.fn() };
    const { result } = renderHook(() => useDiscussion(api, "user_peer"));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    act(() => { result.current.setDraft("Note 8"); });
    await act(async () => { await result.current.send(); });
    expect(api.post).toHaveBeenCalledOnce();
    expect(result.current.draft).toBe("");
    expect(result.current.messages.map(message => message.id)).toContain("note-8");
  });

  it.each(["success", "failure"])("waits for the trailing read's %s before acknowledging a concurrent event", async (outcome) => {
    let resolvePage!: (page: unknown) => void;
    let resolveTrailing!: (page: unknown) => void;
    let rejectTrailing!: (failure: Error) => void;
    let notify!: () => void | Promise<void>;
    const api = { baseUrl: "https://app.matrix-os.com",
      get: vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveTrailing = resolve; rejectTrailing = reject; })),
      post: vi.fn(), delete: vi.fn(),
      subscribe: (_id: string, onEvent: () => void | Promise<void>) => { notify = onEvent; return () => {}; },
    };
    const { result } = renderHook(() => useDiscussion(api));
    let settled = false;
    const refresh = Promise.resolve(notify());
    void refresh.then(() => { settled = true; }, () => { settled = true; });
    await act(async () => {
      resolvePage({ messages: [], latestSequence: "0" });
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    expect(result.current.loading).toBe(true);
    await act(async () => {
      if (outcome === "success") {
        resolveTrailing({ messages: [note(8)], latestSequence: "8" });
        await expect(refresh).resolves.toBeUndefined();
      } else {
        const failure = new Error("trailing read failed");
        rejectTrailing(failure);
        await expect(refresh).rejects.toBe(failure);
      }
    });
    expect(settled).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.messages).toEqual(outcome === "success" ? [note(8)] : []);
    expect(result.current.error).toBe(outcome === "failure");
  });

  it("backfills unseen pages after a local post without skipping to that post's sequence", async () => {
    const api = { baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.includes("after=3")
        ? { messages: [note(6), note(8)], latestSequence: "8" }
        : path.includes("after=8") ? { messages: [], latestSequence: "8" }
        : { messages: [note(3)], latestSequence: "6" }),
      post: vi.fn(async () => note(8)), patch: vi.fn(async () => ({})), delete: vi.fn(),
    };
    const { result } = renderHook(() => useDiscussion(api));
    await waitFor(() => expect(result.current.messages).toEqual([note(3)]));
    act(() => { result.current.setDraft("Note 8"); });
    await act(async () => { await result.current.send(); });
    await waitFor(() => expect(result.current.messages).toEqual([note(3), note(6), note(8)]));
    expect(api.get.mock.calls[1]?.[0]).toContain("after=3&limit=100");
    expect(api.patch).toHaveBeenNthCalledWith(1, expect.any(String), { readThroughSeq: "3" });
    expect(result.current.hasMore).toBe(false);
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.messages).toHaveLength(3);
  });

  it("retains a posted note and watermark when an older in-flight page settles later", async () => {
    let resolvePage!: (page: unknown) => void;
    const api = { baseUrl: "https://app.matrix-os.com",
      get: vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }))
        .mockResolvedValue({ messages: [note(6), note(8)], latestSequence: "8" }),
      post: vi.fn(async () => note(8)), delete: vi.fn(),
    };
    const { result } = renderHook(() => useDiscussion(api));
    act(() => { result.current.setDraft("Note 8"); });
    await act(async () => { await result.current.send(); });
    expect(result.current.messages).toEqual([note(8)]);
    await act(async () => { resolvePage({ messages: [note(3)], latestSequence: "3" }); });
    await waitFor(() => expect(result.current.messages).toEqual([note(3), note(6), note(8)]));
    expect(result.current.latestSequence).toBe("8");
    expect(api.get.mock.calls[1]?.[0]).toContain("after=3&limit=100");
  });

  it("does not acknowledge an event when its canonical read fails", async () => {
    let notify!: () => void | Promise<void>;
    const failure = new Error("read failed");
    const api = { baseUrl: "https://app.matrix-os.com",
      get: vi.fn().mockResolvedValueOnce({ messages: [], latestSequence: "0" }).mockRejectedValueOnce(failure),
      post: vi.fn(), delete: vi.fn(),
      subscribe: (_id: string, onEvent: () => void | Promise<void>) => { notify = onEvent; return () => {}; },
    };
    const { result } = renderHook(() => useDiscussion(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(notify()).rejects.toBe(failure); });
    expect(result.current.error).toBe(true);
    expect(result.current.messages).toEqual([]);
  });

  it("fences a queued refresh from an earlier actor without blocking the new actor", async () => {
    let resolvePage!: (page: unknown) => void;
    let notify!: () => void | Promise<void>;
    const api = { baseUrl: "https://app.matrix-os.com",
      get: vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }))
        .mockResolvedValue({ messages: [note(9)], latestSequence: "9" }),
      post: vi.fn(), delete: vi.fn(),
      subscribe: (_id: string, onEvent: () => void | Promise<void>) => { notify = onEvent; return () => {}; },
    };
    const { result, rerender } = renderHook(({ actor }) => useDiscussion(api, actor), {
      initialProps: { actor: "user_peer" },
    });
    const oldRefresh = notify();
    rerender({ actor: "user_owner" });
    await waitFor(() => expect(result.current.messages).toEqual([note(9)]));
    await act(async () => {
      resolvePage({ messages: [note(3)], latestSequence: "3" });
      await oldRefresh;
    });
    expect(result.current.messages).toEqual([note(9)]);
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
