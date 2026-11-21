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
let mockFocused = true;

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: async () => "session-token" }),
}));
jest.mock("expo-router", () => ({ useIsFocused: () => mockFocused }));
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

function renderMarkRead(initial: CanonicalChatDetailResponse | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
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
});

describe("useMarkChatRead", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFocused = true;
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
  });

  it("marks the open chat read, keeps the read state in the chat's cache and reads the chat list again", async () => {
    readChats.mockResolvedValueOnce("Completed").mockResolvedValue("read");
    const { result, client } = renderMarkRead(detail(unread));

    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledWith(
      "session-token", gatewayUrl, "chat_one", { type: "mark_read", throughSeq: 4, baseVersion: 2 },
    ));
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

    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1));
  });

  it("waits while the app is in the background and acknowledges when it comes back", async () => {
    setAppState("background");
    renderMarkRead(detail(unread));
    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());
    expect(mockUpdateChatReadState).not.toHaveBeenCalled();

    act(() => appStateListener?.("active"));

    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1));
  });

  it("asks once per read version: a refusal is not repeated until the chat is read again", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockUpdateChatReadState.mockRejectedValue(new Error("Could not update the chat."));
    const { rerender } = renderMarkRead(detail(unread));
    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith("[chat] Read state update failed:", "Error"));

    rerender({ shown: detail(unread) });
    await act(async () => {});
    expect(mockUpdateChatReadState).toHaveBeenCalledTimes(1);

    // A newer reply, read again from the server, is a new acknowledgement.
    mockUpdateChatReadState.mockResolvedValue({ ...detail(read).record });
    rerender({ shown: detail({ ...unread, version: 3 }) });
    await waitFor(() => expect(mockUpdateChatReadState).toHaveBeenCalledTimes(2));
  });
});
