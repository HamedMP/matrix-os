import { expect, it, vi } from "vitest";
import { deleteProjectThreadState } from "../../packages/gateway/src/coding-agents/project-thread-deletion.js";
import type { StoredThread, StoredThreadState } from "../../packages/gateway/src/coding-agents/thread-store.js";

function fixture() {
  const thread = { id: "thread_a", ownerId: "owner_a", projectId: "repo", providerId: "codex", status: "running" } as StoredThread;
  const state = { version: 1, threads: [thread, { ...thread, id: "thread_b", ownerId: "owner_b" }], events: [], turns: [], pendingTerminalStops: [] } as StoredThreadState;
  const abortThread = vi.fn(async () => []);
  return { state, abortThread, input: {
    state, principal: { userId: "owner_a", source: "jwt" as const }, projectId: "repo",
    providers: [{ providerId: "codex", startThread: async () => [], abortThread }],
    abortLocal: vi.fn(), now: () => new Date(), nextEventId: () => "evt_delete",
  } };
}

it("stops owned project executions before deleting their records", async () => {
  const f = fixture();
  const result = await deleteProjectThreadState(f.input);
  expect(f.abortThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requireRuntimeStop: true, thread: f.state.threads[0] }));
  expect(f.input.abortLocal).toHaveBeenCalledExactlyOnceWith(f.state.threads[0]);
  expect(result.state.threads.map(thread => thread.id)).toEqual(["thread_b"]);
  expect(f.state.threads).toHaveLength(2);
});

it("retains persisted records when a provider cannot stop, allowing deletion to retry", async () => {
  const f = fixture();
  f.abortThread.mockRejectedValueOnce(new Error("stop unavailable"));
  await expect(deleteProjectThreadState(f.input)).rejects.toThrow("stop unavailable");
  expect(f.state.threads).toHaveLength(2);
  expect((await deleteProjectThreadState(f.input)).result).toEqual({ ok: true, deleted: 1 });
});
