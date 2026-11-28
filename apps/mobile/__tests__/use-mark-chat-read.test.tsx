import type { CanonicalChatDetailResponse, CanonicalChatRecord } from "@matrix-os/contracts";
import React, { type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { QueryClient, QueryClientProvider, notifyManager, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { chatReadAcknowledgement, useMarkChatRead } from "../lib/queries/use-mark-chat-read";
import { mobileQueryKeys } from "../lib/requests/query-keys";
import { disposeTestQueryClient } from "./query-test-cleanup";

const mockFetchActiveComputer = jest.fn();
const mockUpdateChatReadState = jest.fn();
const mockGetToken = jest.fn(async () => "session-token");
let mockFocused = true;
let mockDrawerStatus = "closed";

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: mockGetToken }),
}));
jest.mock("expo-router", () => ({ useIsFocused: () => mockFocused }));
jest.mock("expo-router/drawer", () => ({ useDrawerStatus: () => mockDrawerStatus }));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
jest.mock("@/lib/requests", () => ({
  mobileQueryKeys: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys,
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  updateChatReadState: (...args: unknown[]) => mockUpdateChatReadState(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const detailKey = mobileQueryKeys.canonicalChatDetail("user_a", "alice:primary", "chat_one");
const chatsKey = mobileQueryKeys.canonicalChats("user_a", "alice:primary");
const at = "2026-11-14T09:00:00.000Z";

type ReadState = NonNullable<CanonicalChatRecord["readState"]>;
const unread: ReadState = { unread: true, markedUnread: false, version: 2, readThroughSeq: 1, latestIncomingSeq: 4 };
const read: ReadState = { unread: false, markedUnread: false, version: 3, readThroughSeq: 4, latestIncomingSeq: 4 };

function message(seq: number, role: "user" | "assistant", state = "committed") {
  return { id: `msg_${seq}`, chatId: "chat_one", seq, role, state, parts: [], createdAt: at, updatedAt: at };
}

function detail(readState: ReadState | undefined, messages = [message(1, "user"), message(2, "assistant"), message(3, "user"), message(4, "assistant")]) {
  return {
    record: {
      chat: { id: "chat_one", title: "Release notes", attention: "none", revision: 5, messageCount: 4 },
      ...(readState ? { readState } : {}),
    },
    messages,
    turns: [],
    runs: [],
    activities: [],
  } as unknown as CanonicalChatDetailResponse;
}

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const mounted: (() => void)[] = [];
const clients: QueryClient[] = [];
const readChats = jest.fn();
let appStateListener: ((state: AppStateStatus) => void) | null = null;

// React Native's jest mock leaves `currentState` a function, which jest cannot replace.
const originalAppState = Object.getOwnPropertyDescriptor(AppState, "currentState")!;
function setAppState(state: AppStateStatus) {
  Object.defineProperty(AppState, "currentState", { value: state, configurable: true, writable: true });
}

function renderMarkRead(initial: CanonicalChatDetailResponse | null, sharedClient?: QueryClient) {
  const client = sharedClient ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  if (!sharedClient) clients.push(client);
  if (initial) client.setQueryData(detailKey, initial);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(({ shown }: { shown: CanonicalChatDetailResponse | null }) => {
    // A stand-in for the chat list, which shows the chat as Completed until it is read.
    const chats = useQuery({ queryKey: chatsKey, queryFn: () => readChats() });
    useMarkChatRead(shown);
    return { chats: chats.data };
  }, { wrapper, initialProps: { shown: initial } });
  mounted.push(rendered.unmount);
  return { ...rendered, client };
}

describe("chatReadAcknowledgement", () => {
  it("marks an unread chat read through its last finished reply, at the read version it was shown with", () => {
    expect(chatReadAcknowledgement(detail(unread), unread.version)).toEqual({ type: "mark_read", throughSeq: 4, baseVersion: 2 });
  });

  it("does not count a reply that is still being written", () => {
    const messages = [message(1, "user"), message(2, "assistant"), message(3, "user"), message(4, "assistant", "pending")];

    expect(chatReadAcknowledgement(detail(unread, messages), unread.version)?.throughSeq).toBe(2);
  });

  it("asks for nothing when the chat is read or the server sent no read state", () => {
    expect(chatReadAcknowledgement(detail(read), read.version)).toBeNull();
    expect(chatReadAcknowledgement(detail(undefined), 0)).toBeNull();
  });

  it("leaves a chat someone marked unread while it was open, as Desktop does", () => {
    const markedNow = { ...unread, markedUnread: true, version: 4 };

    expect(chatReadAcknowledgement(detail(markedNow), 3)).toBeNull();
    // Marked unread before this visit: opening it reads it.
    expect(chatReadAcknowledgement(detail(markedNow), 4)).toEqual({ type: "mark_read", throughSeq: 4, baseVersion: 4 });
  });

  it("does not acknowledge an unloaded reply beyond the committed messages delivered to this view", () => {
    expect(chatReadAcknowledgement(detail({ ...unread, readThroughSeq: 2 }, [message(1, "user"), message(2, "assistant")]), 2)).toBeNull();
  });
});

async function advance(ms = 2_000) {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

async function ready() {
  // Resolve the real active-computer query before measuring the debounce.
  await act(async () => {});
  await advance(0);
}

describe("useMarkChatRead", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    mockGetToken.mockResolvedValue("session-token");
    mockFocused = true;
    mockDrawerStatus = "closed";
    appStateListener = null;
    setAppState("active");
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      appStateListener = listener as (state: AppStateStatus) => void;
      return { remove: () => { appStateListener = null; } } as ReturnType<typeof AppState.addEventListener>;
    });
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
    mockUpdateChatReadState.mockResolvedValue({ ...detail(read).record });
    readChats.mockResolvedValue("Completed");
  });

  afterEach(async () => {
    while (mounted.length > 0) mounted.pop()!();
    await Promise.all(clients.splice(0).map(disposeTestQueryClient));
    jest.restoreAllMocks();
    Object.defineProperty(AppState, "currentState", originalAppState);
    jest.useRealTimers();
  });

  it("marks the open chat read, keeps the read state in the chat's cache and reads the chat list again", async () => {
    readChats.mockResolvedValueOnce("Completed").mockResolvedValue("read");
    const { result, client } = renderMarkRead(detail(unread));
    await ready();
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    await advance(1_999);
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    await advance(1);
    expect(mockUpdateChatReadState).toHaveBeenCalledWith(
      expect.any(Function), gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 4, baseVersion: 2 },
    );
    await expect(mockUpdateChatReadState.mock.calls[0]![0]()).resolves.toBe("session-token");
    await waitFor(() => expect(result.current.chats).toBe("read"));
    expect(readChats).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<CanonicalChatDetailResponse>(detailKey)?.record.readState).toEqual(read);
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a chat that is already read", async () => {
    renderMarkRead(detail(read));
    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());

    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
  });

  it("waits while the chat screen is covered by another screen", async () => {
    mockFocused = false;
    const { rerender } = renderMarkRead(detail(unread));
    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();

    mockFocused = true;
    rerender({ shown: detail(unread) });
    await advance();
    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1));
  });

  it("waits while the chat is covered by the side panel, without starting another visit", async () => {
    mockDrawerStatus = "open";
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    await advance();
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    rerender({ shown: detail({ ...unread, markedUnread: true, version: 4 }) });
    mockDrawerStatus = "closed";
    rerender({ shown: detail({ ...unread, markedUnread: true, version: 4 }) });
    await advance();
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
  });

  it("waits while the app is in the background and acknowledges when it comes back", async () => {
    setAppState("background");
    renderMarkRead(detail(unread));
    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();

    act(() => appStateListener?.("active"));
    await advance();
    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1));
  });

  it("asks once per read version: a refusal is not repeated until the chat is read again", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockUpdateChatReadState.mockRejectedValue(new Error("Could not update the chat."));
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    await advance();
    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith("[chat] Read state update failed:", "Error"));

    rerender({ shown: detail(unread) });
    await act(async () => {});
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);

    // A newer reply, read again from the server, is a new acknowledgement.
    mockUpdateChatReadState.mockResolvedValue({ ...detail(read).record });
    rerender({ shown: detail({ ...unread, version: 3 }) });
    await advance();
    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(2));
  });

  it("coalesces committed replies without postponing the first read indefinitely", async () => {
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    await advance(1_000);
    rerender({ shown: detail({ ...unread, latestIncomingSeq: 6 }, [message(4, "assistant"), message(6, "assistant"), message(7, "assistant", "pending")]) });
    await advance(1_000);
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);
    expect(mockUpdateChatReadState).toHaveBeenLastCalledWith(expect.any(Function), gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 6, baseVersion: 2 });
  });

  it("cancels a queued read on background or blur; foreground alone never overrides a new manual unread mark", async () => {
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    await advance(1_000);
    act(() => appStateListener?.("background"));
    await advance();
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    rerender({ shown: detail({ ...unread, markedUnread: true, version: 4 }) });
    act(() => appStateListener?.("active"));
    await advance();
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    // Leaving and reopening is deliberate reading of that reminder.
    mockFocused = false;
    rerender({ shown: detail({ ...unread, markedUnread: true, version: 4 }) });
    mockFocused = true;
    rerender({ shown: detail({ ...unread, markedUnread: true, version: 4 }) });
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);
  });

  it("does not send an acknowledgement after token lookup outlives the visible visit", async () => {
    const { rerender, client } = renderMarkRead(detail(unread));
    await ready();
    let finishToken!: (token: string) => void;
    mockGetToken.mockReturnValueOnce(new Promise<string>((resolve) => { finishToken = resolve; }));
    await advance();
    mockFocused = false;
    rerender({ shown: detail(unread) });
    await act(async () => finishToken("late-token"));
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    expect(client.getQueryData<CanonicalChatDetailResponse>(detailKey)?.record.readState).toEqual(unread);
  });

  it("uses the newest committed reply when streaming updates arrive during token lookup", async () => {
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    let finishToken!: (token: string) => void;
    mockGetToken.mockReturnValueOnce(new Promise<string>((resolve) => { finishToken = resolve; }));
    await advance();
    rerender({ shown: detail({ ...unread, version: 3, latestIncomingSeq: 6 }, [message(6, "assistant"), message(7, "assistant", "pending")]) });
    await act(async () => finishToken("fresh-token"));
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);
    expect(mockUpdateChatReadState).toHaveBeenLastCalledWith(expect.any(Function), gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 6, baseVersion: 3 });
  });

  it("cancels a token lookup across background/foreground even if the same chat becomes visible again", async () => {
    renderMarkRead(detail(unread));
    await ready();
    let finishToken!: (token: string) => void;
    mockGetToken.mockReturnValueOnce(new Promise<string>((resolve) => { finishToken = resolve; }));
    await advance();
    act(() => appStateListener?.("background"));
    act(() => appStateListener?.("active"));
    await act(async () => finishToken("obsolete-token"));
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenLastCalledWith(expect.any(Function), gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 4, baseVersion: 2 });
  });

  it("keeps one read in flight while newer committed replies arrive, then acknowledges the latest snapshot", async () => {
    let finish!: (record: CanonicalChatRecord) => void;
    mockUpdateChatReadState.mockReturnValueOnce(new Promise<CanonicalChatRecord>((resolve) => { finish = resolve; }));
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    await advance();
    const newer = detail({ ...unread, version: 3, latestIncomingSeq: 6 }, [message(6, "assistant")]);
    rerender({ shown: newer });
    await advance(4_000);
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);
    await act(async () => finish(detail(read).record));
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(2);
    expect(mockUpdateChatReadState).toHaveBeenLastCalledWith(expect.any(Function), gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 6, baseVersion: 3 });
  });

  it.each(["token", "HTTP"])("acknowledges a newer reply after an older %s operation fails", async (stage) => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    let fail!: (error: Error) => void;
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    if (stage === "token") mockGetToken.mockReturnValueOnce(pending);
    else mockUpdateChatReadState.mockReturnValueOnce(pending);
    await advance();
    rerender({ shown: detail({ ...unread, version: 3, latestIncomingSeq: 6 }, [message(6, "assistant")]) });
    await act(async () => fail(new Error("Unavailable")));
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(stage === "token" ? 1 : 2);
    expect(mockUpdateChatReadState).toHaveBeenLastCalledWith(expect.any(Function), gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 6, baseVersion: 3 });
  });

  it.each([false, true])("serializes reads across another view of the same chat (previous view unmounted: %s)", async (unmount) => {
    let finish!: (record: CanonicalChatRecord) => void;
    mockUpdateChatReadState.mockReturnValueOnce(new Promise<CanonicalChatRecord>((resolve) => { finish = resolve; }));
    const first = renderMarkRead(detail(unread));
    await ready();
    await advance();
    // A project/agent route can mount while the previous view's request settles.
    if (unmount) first.unmount();
    renderMarkRead(detail(unread), first.client);
    await ready();
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);
    await act(async () => finish(detail(read).record));
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(2);
  });

  it("resumes automatic reading after the owner explicitly clears a manual reminder elsewhere", async () => {
    const { rerender } = renderMarkRead(detail(read));
    await ready();
    rerender({ shown: detail({ ...unread, markedUnread: true, version: 4 }) });
    await advance();
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    rerender({ shown: detail({ ...read, version: 5 }) });
    rerender({ shown: detail({ ...read, version: 5, unread: true, latestIncomingSeq: 6 }, [message(6, "assistant")]) });
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenLastCalledWith(expect.any(Function), gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 6, baseVersion: 5 });
  });

  it("does not spend an attempt when no session is available, and retries on the next visit", async () => {
    const { rerender } = renderMarkRead(detail(unread));
    await ready();
    mockGetToken.mockResolvedValueOnce("");
    await advance();
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();
    mockFocused = false;
    rerender({ shown: detail(unread) });
    mockFocused = true;
    rerender({ shown: detail(unread) });
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);
  });

  it("resets visit identity on a computer switch and discards the previous computer's late result", async () => {
    let finish!: (record: CanonicalChatRecord) => void;
    mockUpdateChatReadState.mockReturnValueOnce(new Promise<CanonicalChatRecord>((resolve) => { finish = resolve; }));
    const { client, rerender } = renderMarkRead(detail(unread));
    await ready();
    await advance();
    act(() => {
      client.setQueryData(mobileQueryKeys.activeComputer("user_a"), { handle: "bob", runtimeSlot: "primary", gatewayPath: "/vm/bob" });
    });
    rerender({ shown: detail({ ...unread, markedUnread: true, version: 8 }) });
    await act(async () => finish(detail(read).record));
    expect(client.getQueryData<CanonicalChatDetailResponse>(detailKey)?.record.readState).toEqual(unread);
    await advance();
    expect(mockUpdateChatReadState).toHaveBeenLastCalledWith(expect.any(Function), "https://app.matrix-os.com/vm/bob", "chat_one", { type: "mark_read", throughSeq: 4, baseVersion: 8 });
  });
});
