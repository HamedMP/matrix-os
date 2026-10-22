import React, { type ReactNode } from "react";
import * as Haptics from "expo-haptics";
import { QueryClient, QueryClientProvider, notifyManager, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useRetryChatTurn } from "../lib/queries/use-retry-chat-turn";
import { mobileQueryKeys } from "../lib/requests/query-keys";
import { disposeTestQueryClient } from "./query-test-cleanup";

const mockFetchActiveComputer = jest.fn();
const mockRetryChatTurn = jest.fn();
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
  retryChatTurn: (...args: unknown[]) => mockRetryChatTurn(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const detailKey = mobileQueryKeys.canonicalChatDetail("user_a", "alice:primary", "chat_one");
const chatsKey = mobileQueryKeys.canonicalChats("user_a", "alice:primary");
const admitted = { run: { id: "run_two", attempt: 2, status: "accepted" }, admission: "accepted" };
const input = { chatId: "chat_one", turnId: "cturn_one", baseRevision: 4, clientRequestId: "req_retry1" };

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const mounted: (() => void)[] = [];
const clients: QueryClient[] = [];

function testQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return client;
}
const readDetail = jest.fn();
const readChats = jest.fn();

function renderRetry() {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => {
    // Stand-ins for the chat screen and the chat list, which show the turn's state.
    const detail = useQuery({ queryKey: detailKey, queryFn: () => readDetail() });
    const chats = useQuery({ queryKey: chatsKey, queryFn: () => readChats() });
    return { retry: useRetryChatTurn(), detail: detail.data, chats: chats.data };
  }, { wrapper });
  mounted.push(rendered.unmount);
  return rendered;
}

describe("useRetryChatTurn", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
    mockRetryChatTurn.mockResolvedValue(admitted);
    readDetail.mockResolvedValue("failed");
    readChats.mockResolvedValue("failed");
  });

  afterEach(async () => {
    while (mounted.length > 0) mounted.pop()!();
    await Promise.all(clients.splice(0).map(disposeTestQueryClient));
  });

  async function ready(result: { current: ReturnType<typeof renderRetry>["result"]["current"] }) {
    await waitFor(() => expect(result.current.detail).toBe("failed"));
    await waitFor(() => expect(result.current.chats).toBe("failed"));
    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());
  }

  it("runs the turn again and then reads the chat and the chat list again", async () => {
    const { result } = renderRetry();
    await ready(result);
    readDetail.mockResolvedValue("running");
    readChats.mockResolvedValue("running");

    await act(async () => {
      await expect(result.current.retry.mutateAsync(input)).resolves.toEqual(admitted);
    });

    expect(mockRetryChatTurn).toHaveBeenCalledWith("session-token", gatewayUrl, "chat_one", "cturn_one", {
      clientRequestId: "req_retry1",
      baseRevision: 4,
    });
    await waitFor(() => expect(result.current.detail).toBe("running"));
    await waitFor(() => expect(result.current.chats).toBe("running"));
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it("reads the chat again after a refusal too, and gives the warning tap", async () => {
    mockRetryChatTurn.mockRejectedValue(new Error("Could not retry. Try again."));
    const { result } = renderRetry();
    await ready(result);
    readDetail.mockResolvedValue("moved on");

    await act(async () => {
      await expect(result.current.retry.mutateAsync(input)).rejects.toThrow("Could not retry. Try again.");
    });

    await waitFor(() => expect(result.current.detail).toBe("moved on"));
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
  });

  it("does not call the server when the session has no token", async () => {
    const { result } = renderRetry();
    await ready(result);
    mockSession.token = null;

    await act(async () => {
      await expect(result.current.retry.mutateAsync(input)).rejects.toThrow("Could not retry. Try again.");
    });

    expect(mockRetryChatTurn).not.toHaveBeenCalled();
  });
});
