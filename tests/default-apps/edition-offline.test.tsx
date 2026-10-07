// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditionDownloads } from "../../home/app-templates/connected-starter/src/edition/offline";
import { useEdition } from "../../home/app-templates/connected-starter/src/edition/useEdition";
import type {
  EditionMessage,
  EditionSource,
} from "../../home/app-templates/connected-starter/src/edition/types";

const source: EditionSource = {
  id: "s1",
  connectionId: "c1",
  email: "reader@example.test",
  label: "Reading",
  scope: "personal",
  state: "completed",
};
const article: EditionMessage = {
  id: "m1",
  sourceId: "s1",
  subject: "An edition",
  sender: "Publication",
  publication: "Publication",
  receivedAt: "2026-10-06T09:00:00Z",
  excerpt: "Old excerpt",
  text: "Old body",
  contentVersion: "v1",
  classification: "newsletter",
  saved: false,
  read: false,
  progress: 0,
  revision: 1,
  readingRevision: 3,
};
const filters = {
  view: "latest" as const,
  scope: "all" as const,
  query: "",
  sourceId: "",
};
function seeded() {
  const cache = new EditionDownloads(localStorage, "trusted-owner-computer");
  cache.setSources([source]);
  cache.download(article);
  return cache;
}
function bridge() {
  return vi.fn(async (action: string) => {
    if (action === "cleanup-recovery") return {operations:[]};
    if (action === "sources")
      return { sources: [source], cacheScope: "server-source-hash" };
    if (action === "messages") return { messages: [article] };
    return article;
  });
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  delete window.MatrixOS;
});
describe("Edition reconnect and background completion", () => {
  it.each([403, 404, 503])(
    "hides an unverified open article after refresh fails with %s",
    async (status) => {
      let denied = false;
      const mail = bridge(),
        original = mail.getMockImplementation()!;
      mail.mockImplementation(async (action) => {
        if (action === "message" && denied)
          throw Object.assign(new Error("Private transport details"), {
            status,
          });
        return original(action);
      });
      window.MatrixOS = { mail };
      const { result } = renderHook(() => useEdition(filters));
      await waitFor(() => expect(result.current.loading).toBe(false));
      await act(async () => {
        await result.current.open("m1");
      });
      expect(result.current.active?.id).toBe("m1");
      denied = true;
      await act(async () => {
        await result.current.reload();
      });
      expect(result.current.active).toBeNull();
      expect(result.current.error).not.toContain("Private transport");
      expect(result.current.error).not.toContain("not found");
      expect(result.current.error).not.toBe("");
    },
  );
  it("keeps a newer selected article when an older refresh settles late", async () => {
    let refreshing = false,
      finish!: (value: unknown) => void;
    const next = { ...article, id: "m2", subject: "A newer selection" };
    const mail = vi.fn(
      async (action: string, payload?: Record<string, unknown>) => {
        if (action === "cleanup-recovery") return {operations:[]};
    if (action === "sources") return { sources: [source] };
        if (action === "messages") return { messages: [article, next] };
        if (payload?.id === "m2") return next;
        if (refreshing)
          return new Promise((resolve) => {
            finish = resolve;
          });
        return article;
      },
    );
    window.MatrixOS = { mail };
    const { result } = renderHook(() => useEdition(filters));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.open("m1");
    });
    refreshing = true;
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.reload();
    });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => {
      await result.current.open("m2");
    });
    await act(async () => {
      finish(article);
      await pending;
    });
    expect(result.current.active?.id).toBe("m2");
  });
  it("removes a remotely deleted download on authenticated contact", async () => {
    const cache = seeded(),
      mail = bridge();
    const original = mail.getMockImplementation()!;
    mail.mockImplementation(async (action) => {
      if (action === "message") throw new Error("Unavailable");
      return original(action);
    });
    window.MatrixOS = { mail, mailCacheScope: "trusted-owner-computer" };
    const { result } = renderHook(() => useEdition(filters));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mail).toHaveBeenCalledWith("message", { id: "m1" });
    expect(cache.list()).toEqual([]);
    expect(result.current.downloaded).toEqual([]);
  });
  it("refreshes downloaded body versions on authenticated contact", async () => {
    const cache = seeded(),
      mail = bridge(),
      original = mail.getMockImplementation()!;
    mail.mockImplementation(async (action) =>
      action === "message"
        ? { ...article, text: "Current body", contentVersion: "v2" }
        : original(action),
    );
    window.MatrixOS = { mail, mailCacheScope: "trusted-owner-computer" };
    const { result } = renderHook(() => useEdition(filters));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(cache.read("m1")?.text).toBe("Current body");
    expect(cache.read("m1")?.contentVersion).toBe("v2");
  });
  it("persists the server reading revision after queued edits replay", async () => {
    const cache = seeded();
    cache.queue({ id: "m1", baseRevision: 3, saved: true });
    const mail = bridge(),
      original = mail.getMockImplementation()!;
    mail.mockImplementation(async (action) =>
      action === "reading"
        ? { ...article, saved: true, readingRevision: 4 }
        : original(action),
    );
    window.MatrixOS = { mail, mailCacheScope: "trusted-owner-computer" };
    const { result } = renderHook(() => useEdition(filters));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mail).toHaveBeenCalledWith("reading", {
      id: "m1",
      baseRevision: 3,
      saved: true,
    });
    expect(cache.pending()).toEqual([]);
    expect(cache.read("m1")).toMatchObject({ saved: true, readingRevision: 4 });
  });
  it("does not authorize persistent downloads from an untrusted sources hash", async () => {
    window.MatrixOS = { mail: bridge() };
    const { result } = renderHook(() => useEdition(filters));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canDownload).toBe(false);
  });
  it("checks pending sync until completed and cancels on unmount", async () => {
    vi.useFakeTimers();
    let completed = false;
    const mail = bridge(),
      original = mail.getMockImplementation()!;
    mail.mockImplementation(async (action) =>
      action === "sources"
        ? {
            sources: [
              { ...source, state: completed ? "completed" : "running" },
            ],
          }
        : action === "messages"
          ? { messages: completed ? [article] : [] }
          : original(action),
    );
    window.MatrixOS = { mail };
    const { result, unmount } = renderHook(() => useEdition(filters));
    await act(async () => {});
    expect(result.current.messages).toEqual([]);
    completed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.messages).toEqual([article]);
    const calls = mail.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mail.mock.calls).toHaveLength(calls);
  });
  it("caps pending-job polling and cancels an active timer on unmount", async () => {
    vi.useFakeTimers();
    const mail = bridge(),
      original = mail.getMockImplementation()!;
    mail.mockImplementation(async (action) =>
      action === "sources"
        ? { sources: [{ ...source, state: "pending" }] }
        : original(action),
    );
    window.MatrixOS = { mail };
    const { unmount } = renderHook(() => useEdition(filters));
    await act(async () => {});
    for (let n = 0; n < 25; n++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
    expect(mail.mock.calls.filter((c) => c[0] === "sources")).toHaveLength(21);
    unmount();
    const next = renderHook(() => useEdition(filters));
    await act(async () => {});
    const calls = mail.mock.calls.length;
    next.unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mail.mock.calls).toHaveLength(calls);
  });
  it("clears old device copies when the trusted runtime scope changes", async () => {
    const cache = seeded();
    window.MatrixOS = {
      mail: bridge(),
      mailCacheScope: "trusted-owner-computer",
    };
    const { result } = renderHook(() => useEdition(filters));
    await waitFor(() => expect(result.current.loading).toBe(false));
    window.MatrixOS.mailCacheScope = "another-owner-computer";
    await act(async () => {
      await result.current.reload();
    });
    expect(cache.list()).toEqual([]);
    expect(result.current.downloaded).toEqual([]);
  });
});
