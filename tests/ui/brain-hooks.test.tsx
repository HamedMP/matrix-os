// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_LIST_MAX_ITEMS, useBrainLoad, useBrainPages,
} from "../../packages/ui/src/brain/use-brain-load.js";
import { BRAIN_JOB_POLL_FIRST_MS, brainJobView, useBrainJob } from "../../packages/ui/src/brain/use-brain-job.js";
import { apiError } from "./brain-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("useBrainLoad", () => {
  it("is idle without a key, loads, reloads keeping data, and replaces", async () => {
    let answer = 1;
    const { result, rerender } = renderHook(({ key }) => useBrainLoad(async () => answer, key), {
      initialProps: { key: null as string | null },
    });
    expect(result.current.state).toEqual({ status: "idle" });
    act(() => result.current.replace(9));
    expect(result.current.state).toEqual({ status: "idle" });
    rerender({ key: "a" });
    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: 1 }));
    answer = 2;
    act(() => result.current.reload());
    expect(result.current.state).toEqual({ status: "ready", data: 1 });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: 2 }));
    act(() => result.current.replace(7));
    expect(result.current.state).toEqual({ status: "ready", data: 7 });
    rerender({ key: "b" });
    expect(result.current.state).toEqual({ status: "loading" });
  });

  it("reads the same key again on a new ask, keeping its data meanwhile", async () => {
    let answer = 1;
    const { result, rerender } = renderHook(({ ask }) => useBrainLoad(async () => answer, "a", ask), {
      initialProps: { ask: 1 },
    });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: 1 }));
    answer = 2;
    rerender({ ask: 2 });
    expect(result.current.state).toEqual({ status: "ready", data: 1 });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: 2 }));
  });

  it("drops a replace made for a key the view has left", async () => {
    const { result, rerender } = renderHook(({ key }) => useBrainLoad(async () => key, key), { initialProps: { key: "day" } });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "day" }));
    const replaceDay = result.current.replace;
    rerender({ key: "week" });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "week" }));
    act(() => replaceDay("late rebuild of the day"));
    expect(result.current.state).toEqual({ status: "ready", data: "week" });
  });

  it("reports errors and drops an answer that arrives after a newer request", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const queue = [slow, fast];
    const { result, rerender } = renderHook(({ key }) => useBrainLoad(() => queue.shift()!.promise, key), {
      initialProps: { key: "one" },
    });
    rerender({ key: "two" });
    fast.reject(apiError("server", "revision_conflict"));
    await waitFor(() => expect(result.current.state).toEqual({
      status: "error", error: { kind: "rejected", code: "revision_conflict" },
    }));
    slow.resolve("late");
    await act(async () => { await slow.promise; });
    expect(result.current.state.status).toBe("error");
    const failing = renderHook(() => useBrainLoad(() => Promise.reject(apiError("offline")), "x"));
    await waitFor(() => expect(failing.result.current.state).toEqual({ status: "error", error: { kind: "offline" } }));
    const stale = deferred<string>();
    const unmounted = renderHook(() => useBrainLoad(() => stale.promise, "y"));
    unmounted.unmount();
    stale.reject(apiError("timeout"));
    await act(async () => { await stale.promise.catch(() => undefined); });
  });
});

describe("useBrainPages", () => {
  it("loads more pages, guards re-entry, keeps the cursor after a failure and caps the list", async () => {
    const pending: { cursor: string | undefined; done: ReturnType<typeof deferred<{ items: number[]; nextCursor: string | null }>> }[] = [];
    const fetchPage = (cursor: string | undefined) => {
      const done = deferred<{ items: number[]; nextCursor: string | null }>();
      pending.push({ cursor, done });
      return done.promise;
    };
    const { result, rerender } = renderHook(({ key }) => useBrainPages(fetchPage, key), {
      initialProps: { key: null as string | null },
    });
    act(() => result.current.loadMore());
    expect(pending).toHaveLength(0);
    rerender({ key: "k" });
    await act(async () => { pending[0]!.done.resolve({ items: [1, 2], nextCursor: "c2" }); });
    expect(result.current.items).toEqual([1, 2]);
    expect(result.current.nextCursor).toBe("c2");
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);
    act(() => result.current.loadMore());
    expect(pending).toHaveLength(2);
    expect(pending[1]!.cursor).toBe("c2");
    await act(async () => { pending[1]!.done.reject(apiError("timeout")); });
    expect(result.current.moreError).toEqual({ kind: "timeout" });
    expect(result.current.nextCursor).toBe("c2");
    act(() => result.current.loadMore());
    await act(async () => {
      pending[2]!.done.resolve({ items: Array.from({ length: BRAIN_LIST_MAX_ITEMS }, (_, index) => index), nextCursor: "c3" });
    });
    expect(result.current.items).toHaveLength(BRAIN_LIST_MAX_ITEMS + 2);
    expect(result.current.nextCursor).toBeNull();
    expect(result.current.moreError).toBeNull();
  });

  it("drops a page, or a failed page, that lands after the list changed", async () => {
    const pending: ReturnType<typeof deferred<{ items: string[]; nextCursor: string | null }>>[] = [];
    const fetchPage = () => {
      const done = deferred<{ items: string[]; nextCursor: string | null }>();
      pending.push(done);
      return done.promise;
    };
    const { result, rerender } = renderHook(({ key }) => useBrainPages(fetchPage, key), { initialProps: { key: "a" } });
    await act(async () => { pending[0]!.resolve({ items: ["a1"], nextCursor: "next" }); });
    act(() => result.current.loadMore());
    act(() => result.current.loadMore());
    rerender({ key: "b" });
    await act(async () => { pending[2]!.resolve({ items: ["b1"], nextCursor: "nb" }); });
    act(() => result.current.loadMore());
    await act(async () => { pending[1]!.resolve({ items: ["a2"], nextCursor: null }); });
    expect(result.current.items).toEqual(["b1"]);
    expect(result.current.loadingMore).toBe(true);
    await act(async () => { pending[3]!.resolve({ items: ["b2"], nextCursor: "more" }); });
    expect(result.current.items).toEqual(["b1", "b2"]);
    act(() => result.current.loadMore());
    rerender({ key: "a" });
    await act(async () => { pending[5]!.resolve({ items: ["a1"], nextCursor: "next" }); });
    act(() => result.current.loadMore());
    await act(async () => { pending[4]!.reject(apiError("offline")); });
    expect(result.current.items).toEqual(["a1"]);
    expect(result.current.moreError).toBeNull();
    expect(result.current.loadingMore).toBe(true);
  });

  it("keeps loaded pages on a repeat, and never mixes an old cursor's page into the new first page", async () => {
    const pending: { cursor: string | undefined; done: ReturnType<typeof deferred<{ items: string[]; nextCursor: string | null }>> }[] = [];
    const fetchPage = (cursor: string | undefined) => {
      const done = deferred<{ items: string[]; nextCursor: string | null }>();
      pending.push({ cursor, done });
      return done.promise;
    };
    const { result, rerender } = renderHook(({ ask }) => useBrainPages(fetchPage, "k", ask), { initialProps: { ask: 1 } });
    await act(async () => { pending[0]!.done.resolve({ items: ["a1"], nextCursor: "c2" }); });
    act(() => result.current.loadMore());
    await act(async () => { pending[1]!.done.resolve({ items: ["a2"], nextCursor: "c3" }); });
    rerender({ ask: 2 });
    expect(result.current.items).toEqual(["a1", "a2"]);
    act(() => result.current.loadMore());
    expect(pending[3]!.cursor).toBe("c3");
    await act(async () => { pending[2]!.done.resolve({ items: ["n1"], nextCursor: "n2" }); });
    await act(async () => { pending[3]!.done.resolve({ items: ["a3"], nextCursor: null }); });
    expect(result.current.items).toEqual(["n1"]);
    expect(result.current.nextCursor).toBe("n2");
    expect(result.current.loadingMore).toBe(false);
  });
});

describe("useBrainJob", () => {
  afterEach(() => { vi.useRealTimers(); });
  const running = brainJobView({ jobId: "job_1", status: "running" })!;
  const cancelled = { jobId: "job_1", status: "cancelled" };
  const follow = (poll: () => Promise<unknown>, cancel: () => Promise<unknown>) => {
    const onFinished = vi.fn();
    const hook = renderHook(() => useBrainJob({ poll, cancel, onFinished }));
    act(() => hook.result.current.start("sync:git", running));
    return { ...hook, onFinished };
  };

  it("keeps a stopped job finished when an older poll answer lands after the cancel", async () => {
    vi.useFakeTimers();
    const poll = deferred<unknown>();
    const cancel = deferred<unknown>();
    const { result, onFinished } = follow(() => poll.promise, () => cancel.promise);
    act(() => { vi.advanceTimersByTime(BRAIN_JOB_POLL_FIRST_MS); });
    act(() => result.current.stop());
    await act(async () => { cancel.resolve(cancelled); poll.resolve(running); });
    expect(result.current.watch?.phase).toBe("finished");
    expect(result.current.running).toBe(false);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith("sync:git", expect.objectContaining({ status: "cancelled" }));
  });

  it("does not report a cancel that lands after the screen closed", async () => {
    const cancel = deferred<unknown>();
    const { result, unmount, onFinished } = follow(() => new Promise(() => undefined), () => cancel.promise);
    act(() => result.current.stop());
    unmount();
    await act(async () => { cancel.resolve(cancelled); });
    expect(onFinished).not.toHaveBeenCalled();
  });
});
