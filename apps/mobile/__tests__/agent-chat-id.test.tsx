import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useAgentChatId } from "../components/agents/use-agent-chat-id";
import { mobileQueryKeys } from "../lib/requests/query-keys";

const mockFetchActiveComputer = jest.fn();
const mockEnsureAgentDirectChat = jest.fn();

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: async () => "session-token" }),
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
jest.mock("@/lib/requests", () => ({
  mobileQueryKeys: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys,
  AgentRequestError: jest.requireActual("@/lib/requests/bots").AgentRequestError,
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  ensureAgentDirectChat: (...args: unknown[]) => mockEnsureAgentDirectChat(...args),
}));

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const mounted: (() => void)[] = [];

async function renderChatId(agentId: string, knownChatId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    (props: { agentId: string; knownChatId: string | null }) => useAgentChatId(props.agentId, props.knownChatId),
    { wrapper, initialProps: { agentId, knownChatId } },
  );
  mounted.push(rendered.unmount);
  await waitFor(() => expect(client.getQueryData(mobileQueryKeys.activeComputer("user_a"))).toBeTruthy());
  return rendered;
}

describe("finding an agent's chat", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
  });

  it("uses the chat already known from the agents' statuses, without asking the server", async () => {
    const { result } = await renderChatId("bot_research1", "chat_research");

    expect(result.current).toMatchObject({ chatId: "chat_research", failed: false });
    expect(mockEnsureAgentDirectChat).not.toHaveBeenCalled();
  });

  it("asks the server for the chat when none is known, and has none until it answers", async () => {
    let answer: (chatId: string) => void = () => {};
    mockEnsureAgentDirectChat.mockReturnValue(new Promise<string>((resolve) => { answer = resolve; }));
    const { result } = await renderChatId("bot_research1", null);

    await waitFor(() => expect(mockEnsureAgentDirectChat).toHaveBeenCalledTimes(1));
    expect(mockEnsureAgentDirectChat).toHaveBeenCalledWith(
      "session-token", "https://app.matrix-os.com/vm/alice", "bot_research1",
    );
    expect(result.current).toMatchObject({ chatId: null, failed: false });

    await act(async () => answer("chat_created"));

    await waitFor(() => expect(result.current.chatId).toBe("chat_created"));
    expect(result.current.failed).toBe(false);
  });

  it("says so when the chat could not be found, and looks again on retry", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockEnsureAgentDirectChat.mockRejectedValueOnce(new Error("upstream said no"));
    const { result } = await renderChatId("bot_research1", null);

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.chatId).toBeNull();

    mockEnsureAgentDirectChat.mockResolvedValue("chat_research");
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.chatId).toBe("chat_research"));
    expect(result.current.failed).toBe(false);
    expect(mockEnsureAgentDirectChat).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("keeps the chat it found when a later read of the statuses no longer names it", async () => {
    const { result, rerender } = await renderChatId("bot_research1", "chat_research");

    rerender({ agentId: "bot_research1", knownChatId: null });

    expect(result.current).toMatchObject({ chatId: "chat_research", failed: false });
    expect(mockEnsureAgentDirectChat).not.toHaveBeenCalled();
  });

  it("stops asking once the statuses name the chat", async () => {
    mockEnsureAgentDirectChat.mockReturnValue(new Promise<string>(() => {}));
    const { result, rerender } = await renderChatId("bot_research1", null);
    await waitFor(() => expect(mockEnsureAgentDirectChat).toHaveBeenCalledTimes(1));

    rerender({ agentId: "bot_research1", knownChatId: "chat_research" });

    expect(result.current.chatId).toBe("chat_research");
    expect(mockEnsureAgentDirectChat).toHaveBeenCalledTimes(1);
  });
});
