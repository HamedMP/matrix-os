import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useCancelRun } from "../lib/queries/use-cancel-run";
import { mobileQueryKeys } from "../lib/requests/query-keys";

const mockFetchActiveComputer = jest.fn();
const mockCancelChatRun = jest.fn();
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
  canonicalChatRequestId: () => "req_minted",
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  cancelChatRun: (...args: unknown[]) => mockCancelChatRun(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const detailKey = mobileQueryKeys.canonicalChatDetail("user_a", "alice:primary", "chat_one");
const chatsKey = mobileQueryKeys.canonicalChats("user_a", "alice:primary");
const aborted = { run: { id: "run_one", status: "aborted" }, cancellation: "aborted" };

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const mounted: (() => void)[] = [];
const readDetail = jest.fn();
const readChats = jest.fn();

function renderCancel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => {
    // Stand-ins for the chat screen and the chat list, which show the run's state.
    const detail = useQuery({ queryKey: detailKey, queryFn: () => readDetail() });
    const chats = useQuery({ queryKey: chatsKey, queryFn: () => readChats() });
    return { cancel: useCancelRun(), detail: detail.data, chats: chats.data };
  }, { wrapper });
  mounted.push(rendered.unmount);
  return rendered;
}

describe("useCancelRun", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
    mockCancelChatRun.mockResolvedValue(aborted);
    readDetail.mockResolvedValue("running");
    readChats.mockResolvedValue("running");
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
  });

  async function ready(result: { current: ReturnType<typeof renderCancel>["result"]["current"] }) {
    await waitFor(() => expect(result.current.detail).toBe("running"));
    await waitFor(() => expect(result.current.chats).toBe("running"));
    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());
  }

  it("stops the run and then reads the chat and the chat list again", async () => {
    const { result } = renderCancel();
    await ready(result);
    readDetail.mockResolvedValue("stopped");
    readChats.mockResolvedValue("stopped");

    await act(async () => {
      await expect(result.current.cancel.mutateAsync({ chatId: "chat_one", runId: "run_one", clientRequestId: "req_stop1" }))
        .resolves.toEqual(aborted);
    });

    expect(mockCancelChatRun).toHaveBeenCalledWith("session-token", gatewayUrl, "chat_one", "run_one", "req_stop1");
    await waitFor(() => expect(result.current.detail).toBe("stopped"));
    await waitFor(() => expect(result.current.chats).toBe("stopped"));
  });

  it("mints a request id when the caller has none", async () => {
    const { result } = renderCancel();
    await ready(result);

    await act(async () => {
      await result.current.cancel.mutateAsync({ chatId: "chat_one", runId: "run_one" });
    });

    expect(mockCancelChatRun).toHaveBeenCalledWith("session-token", gatewayUrl, "chat_one", "run_one", "req_minted");
  });

  it("is released as soon as the server answers, without waiting for the re-read", async () => {
    const { result } = renderCancel();
    await ready(result);
    readDetail.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await result.current.cancel.mutateAsync({ chatId: "chat_one", runId: "run_one" });
    });

    await waitFor(() => expect(result.current.cancel.isSuccess).toBe(true));
    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
  });

  it("reads the chat again after a refusal too, because the run may already have ended", async () => {
    mockCancelChatRun.mockRejectedValue(new Error("Could not stop the run. Try again."));
    const { result } = renderCancel();
    await ready(result);
    readDetail.mockResolvedValue("completed");

    await act(async () => {
      await expect(result.current.cancel.mutateAsync({ chatId: "chat_one", runId: "run_one" }))
        .rejects.toThrow("Could not stop the run. Try again.");
    });

    await waitFor(() => expect(result.current.detail).toBe("completed"));
  });

  it("does not call the server when the session has no token", async () => {
    const { result } = renderCancel();
    await ready(result);
    mockSession.token = null;

    await act(async () => {
      await expect(result.current.cancel.mutateAsync({ chatId: "chat_one", runId: "run_one" }))
        .rejects.toThrow("Could not stop the run. Try again.");
    });

    expect(mockCancelChatRun).not.toHaveBeenCalled();
  });
});
