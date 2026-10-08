import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { MAX_OLDER_CHAT_PAGES } from "../lib/chat-pages";
import { useCanonicalChatPages, useCanonicalChats } from "../lib/queries/use-canonical-chats";
import { useChatSearch } from "../lib/queries/use-chat-search";
import { useProjectChats } from "../lib/queries/use-project-chats";

const mockFetchActiveComputer = jest.fn();
const mockFetchChats = jest.fn();
const mockFetchProjectChats = jest.fn();
const mockSearchChats = jest.fn();
let mockSession: { isSignedIn: boolean; userId: string | null; token: string | null };

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: mockSession.isSignedIn,
    userId: mockSession.userId,
    getToken: async () => mockSession.token,
  }),
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
jest.mock("@/lib/requests", () => ({
  mobileQueryKeys: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys,
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  fetchChats: (...args: unknown[]) => mockFetchChats(...args),
  fetchProjectChats: (...args: unknown[]) => mockFetchProjectChats(...args),
  searchChats: (...args: unknown[]) => mockSearchChats(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const CURSOR = "chatcur_after_";

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const record = (id: string, title = id) => ({ chat: { id, title } });
const idsOf = (chats: readonly { chat: { id: string } }[]) => chats.map((entry) => entry.chat.id);

/** A list served two chats at a time, continuing after the chat a cursor names. */
function pageOf(order: readonly string[], cursor?: string, size = 2) {
  const start = cursor ? order.indexOf(cursor.slice(CURSOR.length)) + 1 : 0;
  const ids = order.slice(start, start + size);
  const more = start + size < order.length;
  return { items: ids.map((id) => record(id)), ...(more ? { nextCursor: `${CURSOR}${ids[ids.length - 1]}` } : {}) };
}

const mounted: (() => void)[] = [];

function createClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function track<T extends { unmount: () => void }>(rendered: T): T {
  mounted.push(rendered.unmount);
  return rendered;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
  mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!();
});

describe("useCanonicalChatPages", () => {
  // The order the server would list chats in right now.
  let serverChats: string[];
  const cursorsRequested = () => mockFetchChats.mock.calls.map(([, , options]) => options?.cursor);

  beforeEach(() => {
    serverChats = ["a", "b", "c", "d", "e"];
    mockFetchChats.mockImplementation(async (_token: string, _url: string, options?: { cursor?: string }) =>
      pageOf(serverChats, options?.cursor));
  });

  function renderPages() {
    const { wrapper } = createClient();
    return track(renderHook(() => useCanonicalChatPages(), { wrapper }));
  }

  it("shows the first page and offers more while the server has a cursor", async () => {
    const { result } = renderPages();

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isLoadingMore).toBe(false);
    expect(result.current.computer).toMatchObject({ handle: "alice" });
    expect(mockFetchChats).toHaveBeenCalledTimes(1);
    expect(mockFetchChats).toHaveBeenCalledWith("session-token", gatewayUrl);
  });

  it("offers nothing more when the first page is the whole list", async () => {
    serverChats = ["a", "b"];
    const { result } = renderPages();

    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(mockFetchChats).toHaveBeenCalledTimes(1);
  });

  it("appends older pages from where the previous one ended, until there are none left", async () => {
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d", "e"]));
    expect(result.current.hasMore).toBe(false);
    expect(cursorsRequested()).toEqual([undefined, `${CURSOR}b`, `${CURSOR}d`]);
  });

  it("keeps offering more after an empty page that still has a cursor", async () => {
    mockFetchChats.mockImplementation(async (_token: string, _url: string, options?: { cursor?: string }) => {
      if (!options?.cursor) return { items: [record("a")], nextCursor: `${CURSOR}a` };
      if (options.cursor === `${CURSOR}a`) return { items: [], nextCursor: `${CURSOR}gap` };
      return { items: [record("z")] };
    });
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a"]));

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(mockFetchChats).toHaveBeenCalledTimes(2));
    expect(idsOf(result.current.chats)).toEqual(["a"]);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "z"]));
    expect(result.current.hasMore).toBe(false);
  });

  it("reads the older pages again from the first page's new end when the first page moves", async () => {
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    await act(async () => {
      await result.current.loadMore();
    });
    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d", "e"]));

    // A new chat pushes "b" off the first page; pages read from the old cursor would skip it.
    serverChats = ["n", "a", "b", "c", "d", "e"];
    await act(async () => {
      await result.current.invalidate();
    });

    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["n", "a", "b", "c", "d", "e"]));
    expect(cursorsRequested().slice(3)).toEqual([undefined, `${CURSOR}a`, `${CURSOR}c`]);
    expect(result.current.hasMore).toBe(false);
  });

  it("leaves the older pages alone when the first page is read again and ends where it did", async () => {
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]));

    await act(async () => {
      await result.current.invalidate();
    });

    await waitFor(() => expect(mockFetchChats).toHaveBeenCalledTimes(3));
    expect(cursorsRequested()).toEqual([undefined, `${CURSOR}b`, undefined]);
    expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]);
  });

  it("reads every loaded page again on a refresh, even when the first page ends where it did", async () => {
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]));
    mockFetchChats.mockImplementation(async (_token: string, _url: string, options?: { cursor?: string }) => {
      const page = pageOf(serverChats, options?.cursor);
      return { ...page, items: page.items.map((item) => record(item.chat.id, "renamed")) };
    });

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.chats.map((entry) => entry.chat.title))
      .toEqual(["renamed", "renamed", "renamed", "renamed"]));
    expect(cursorsRequested()).toEqual([undefined, `${CURSOR}b`, undefined, `${CURSOR}b`]);
  });

  it("lists a chat once when it is on the first page and on an older one", async () => {
    mockFetchChats.mockImplementation(async (_token: string, _url: string, options?: { cursor?: string }) =>
      options?.cursor
        ? { items: [record("b", "stale title"), record("c")] }
        : { items: [record("a"), record("b", "current title")], nextCursor: `${CURSOR}b` });
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c"]));
    expect(result.current.chats[1]!.chat.title).toBe("current title");
  });

  it("keeps the loaded chats and the offer of more when an older page fails", async () => {
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    mockFetchChats.mockRejectedValueOnce(new Error("offline"));

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(result.current.isLoadMoreError).toBe(true));
    expect(idsOf(result.current.chats)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isError).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]));
    expect(result.current.isLoadMoreError).toBe(false);
  });

  it("reports loading only while a page that was asked for is on its way", async () => {
    const { result } = renderPages();
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    let answer!: (value: unknown) => void;
    mockFetchChats.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

    let request!: Promise<void>;
    act(() => { request = result.current.loadMore(); });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true));
    await act(async () => {
      answer(pageOf(serverChats, `${CURSOR}b`));
      await request;
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]));
    expect(result.current.isLoadingMore).toBe(false);

    // The first page moves, so the older page is read again -- in the background.
    serverChats = ["n", "a", "b", "c", "d", "e"];
    let answerReread!: (value: unknown) => void;
    mockFetchChats
      .mockResolvedValueOnce(pageOf(serverChats))
      .mockReturnValueOnce(new Promise((resolve) => { answerReread = resolve; }));
    await act(async () => {
      await result.current.invalidate();
    });
    await waitFor(() => expect(mockFetchChats).toHaveBeenCalledTimes(4));
    expect(result.current.isLoadingMore).toBe(false);
    await act(async () => {
      answerReread(pageOf(serverChats, `${CURSOR}a`));
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["n", "a", "b", "c"]));
  });

  it("stops offering more at the page limit and says that it has", async () => {
    serverChats = Array.from({ length: MAX_OLDER_CHAT_PAGES + 3 }, (_unused, index) => `chat${index}`);
    mockFetchChats.mockImplementation(async (_token: string, _url: string, options?: { cursor?: string }) =>
      pageOf(serverChats, options?.cursor, 1));
    const { result } = renderPages();
    await waitFor(() => expect(result.current.chats).toHaveLength(1));

    for (let page = 0; page < MAX_OLDER_CHAT_PAGES; page += 1) {
      expect(result.current.hasMore).toBe(true);
      expect(result.current.atPageLimit).toBe(false);
      await act(async () => {
        await result.current.loadMore();
      });
      await waitFor(() => expect(result.current.chats).toHaveLength(page + 2));
    }

    expect(result.current.hasMore).toBe(false);
    expect(result.current.atPageLimit).toBe(true);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(mockFetchChats).toHaveBeenCalledTimes(MAX_OLDER_CHAT_PAGES + 1);
  });

  it("gives the screens that only read the first page the same list as before", async () => {
    const { wrapper } = createClient();
    const { result } = track(renderHook(() => ({ first: useCanonicalChats(), pages: useCanonicalChatPages() }), { wrapper }));
    await waitFor(() => expect(idsOf(result.current.first.chats)).toEqual(["a", "b"]));

    await act(async () => {
      await result.current.pages.loadMore();
    });

    await waitFor(() => expect(idsOf(result.current.pages.chats)).toEqual(["a", "b", "c", "d"]));
    expect(idsOf(result.current.first.chats)).toEqual(["a", "b"]);
    expect(Object.keys(result.current.first).sort()).toEqual(["chats", "computer", "invalidate", "isError", "isPending"]);
    // Both hooks read the first page from one cached request.
    expect(cursorsRequested()).toEqual([undefined, `${CURSOR}b`]);
  });

  it("stays idle without a signed-in account", async () => {
    mockSession = { isSignedIn: false, userId: null, token: null };
    const { result } = renderPages();

    expect(result.current.isPending).toBe(false);
    expect(result.current.chats).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(mockFetchChats).not.toHaveBeenCalled();
  });
});

describe("useProjectChats", () => {
  let serverChats: string[];
  const cursorsRequested = () => mockFetchProjectChats.mock.calls.map(([, , , options]) => options?.cursor);

  beforeEach(() => {
    serverChats = ["a", "b", "c", "d", "e"];
    mockFetchProjectChats.mockImplementation(
      async (_token: string, _url: string, _projectId: string, options?: { cursor?: string }) =>
        pageOf(serverChats, options?.cursor),
    );
  });

  function renderProjectChats(projectId: string | null) {
    const { client, wrapper } = createClient();
    const rendered = track(renderHook(
      ({ id }: { id: string | null }) => useProjectChats(id),
      { wrapper, initialProps: { id: projectId } },
    ));
    return { ...rendered, client };
  }

  it("reads the first page of the project's chats", async () => {
    const { result } = renderProjectChats("proj_site");

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    expect(result.current.hasMore).toBe(true);
    expect(mockFetchProjectChats).toHaveBeenCalledWith("session-token", gatewayUrl, "proj_site", { cursor: undefined });
  });

  it("appends further pages and stops when there are none left", async () => {
    const { result } = renderProjectChats("proj_site");
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]));
    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d", "e"]));
    expect(result.current.hasMore).toBe(false);
    expect(cursorsRequested()).toEqual([undefined, `${CURSOR}b`, `${CURSOR}d`]);
  });

  it("keeps offering more after an empty page that still has a cursor", async () => {
    mockFetchProjectChats
      .mockResolvedValueOnce({ items: [], nextCursor: `${CURSOR}gap` })
      .mockResolvedValueOnce({ items: [record("z")] });
    const { result } = renderProjectChats("proj_site");

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.chats).toEqual([]);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["z"]));
    expect(result.current.hasMore).toBe(false);
  });

  it("keeps the loaded chats and the offer of more when a further page fails", async () => {
    const { result } = renderProjectChats("proj_site");
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    mockFetchProjectChats.mockRejectedValueOnce(new Error("offline"));

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(result.current.isLoadMoreError).toBe(true));
    expect(idsOf(result.current.chats)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isError).toBe(false);
  });

  it("reports a first page that cannot be loaded", async () => {
    mockFetchProjectChats.mockRejectedValue(new Error("offline"));
    const { result } = renderProjectChats("proj_site");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.chats).toEqual([]);
    expect(result.current.isPending).toBe(false);
  });

  it("reads every loaded page again when the chat list is refreshed", async () => {
    const { result, client } = renderProjectChats("proj_site");
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b"]));
    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["a", "b", "c", "d"]));

    // What sending a message or a chat event does to the unscoped list's key.
    serverChats = ["n", "a", "b", "c", "d", "e"];
    await act(async () => {
      await client.invalidateQueries({
        queryKey: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys.canonicalChats("user_a", "alice:primary"),
      });
    });

    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["n", "a", "b", "c"]));
  });

  it("keeps each project's chats apart", async () => {
    mockFetchProjectChats.mockImplementation(async (_token: string, _url: string, projectId: string) =>
      ({ items: [record(`${projectId}_chat`)] }));
    const { result, rerender } = renderProjectChats("proj_site");
    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["proj_site_chat"]));

    rerender({ id: "proj_notes" });

    await waitFor(() => expect(idsOf(result.current.chats)).toEqual(["proj_notes_chat"]));
  });

  it("stays idle until there is a project", () => {
    const { result } = renderProjectChats(null);

    expect(result.current.isPending).toBe(false);
    expect(result.current.chats).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    expect(mockFetchProjectChats).not.toHaveBeenCalled();
  });
});

describe("useChatSearch", () => {
  function renderSearch(query: string) {
    const { wrapper } = createClient();
    return track(renderHook(
      (props: { query: string; projectId?: string }) =>
        useChatSearch(props.query, props.projectId ? { projectId: props.projectId } : undefined),
      { wrapper, initialProps: { query } as { query: string; projectId?: string } },
    ));
  }

  beforeEach(() => {
    mockSearchChats.mockImplementation(async (_token: string, _url: string, query: string) => [record(`hit_${query}`)]);
  });

  it.each(["", "   ", "\n\t"])("does not search for the empty query %j", async (query) => {
    const { result } = renderSearch(query);

    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toEqual([]);
    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());
    expect(mockSearchChats).not.toHaveBeenCalled();
  });

  it("searches for the trimmed query as soon as it is given one", async () => {
    const { result } = renderSearch("  lisbon ");

    expect(result.current.isSearching).toBe(true);
    await waitFor(() => expect(idsOf(result.current.results)).toEqual(["hit_lisbon"]));
    expect(result.current.isSearching).toBe(false);
    expect(mockSearchChats).toHaveBeenCalledTimes(1);
    expect(mockSearchChats).toHaveBeenCalledWith("session-token", gatewayUrl, "lisbon", {});
  });

  it("follows the query as it changes and shows only the current query's results", async () => {
    let answerPorto!: (value: unknown) => void;
    const { result, rerender } = renderSearch("lisbon");
    await waitFor(() => expect(idsOf(result.current.results)).toEqual(["hit_lisbon"]));
    mockSearchChats.mockReturnValueOnce(new Promise((resolve) => { answerPorto = resolve; }));

    rerender({ query: "porto" });

    await waitFor(() => expect(mockSearchChats).toHaveBeenCalledTimes(2));
    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(true);
    await act(async () => {
      answerPorto([record("hit_porto")]);
    });
    await waitFor(() => expect(idsOf(result.current.results)).toEqual(["hit_porto"]));
  });

  it("clears the results when the query is emptied", async () => {
    const { result, rerender } = renderSearch("lisbon");
    await waitFor(() => expect(idsOf(result.current.results)).toEqual(["hit_lisbon"]));

    rerender({ query: " " });

    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(mockSearchChats).toHaveBeenCalledTimes(1);
  });

  it("does not ask again for a query it already has results for", async () => {
    const { result, rerender } = renderSearch("lisbon");
    await waitFor(() => expect(idsOf(result.current.results)).toEqual(["hit_lisbon"]));

    rerender({ query: "lisbon " });

    expect(idsOf(result.current.results)).toEqual(["hit_lisbon"]);
    expect(mockSearchChats).toHaveBeenCalledTimes(1);
  });

  it("can search inside one project, kept apart from the search of every chat", async () => {
    const { result, rerender } = renderSearch("lisbon");
    await waitFor(() => expect(idsOf(result.current.results)).toEqual(["hit_lisbon"]));

    rerender({ query: "lisbon", projectId: "proj_site" });

    await waitFor(() => expect(mockSearchChats).toHaveBeenCalledTimes(2));
    expect(mockSearchChats).toHaveBeenLastCalledWith("session-token", gatewayUrl, "lisbon", { projectId: "proj_site" });
  });

  it("reports a failed search without results", async () => {
    mockSearchChats.mockRejectedValue(new Error("Search unavailable. Try again."));
    const { result } = renderSearch("lisbon");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });
});
