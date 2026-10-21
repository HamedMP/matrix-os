import React, { type ReactNode } from "react";
import type { ChatAgent } from "@matrix-os/contracts";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useAgentStatuses } from "../lib/queries/use-agent-statuses";

const mockFetchActiveComputer = jest.fn();
const mockFetchAgentDirectChat = jest.fn();
const mockFetchAgentTasks = jest.fn();
const mockFetchAgentInteractions = jest.fn();
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
  fetchAgentDirectChat: (...args: unknown[]) => mockFetchAgentDirectChat(...args),
  fetchAgentTasks: (...args: unknown[]) => mockFetchAgentTasks(...args),
  fetchAgentInteractions: (...args: unknown[]) => mockFetchAgentInteractions(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const at = "2026-10-08T09:00:00.000Z";
const soon = new Date(Date.now() + 60 * 60_000).toISOString();

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

function agent(id: string, template = true): ChatAgent {
  return {
    id,
    revision: 1,
    name: id,
    description: "",
    instructions: "Help",
    selection: { instanceId: "matrix_pi_default", model: "auto" },
    archived: false,
    createdAt: at,
    updatedAt: at,
    ...(template ? { recipeRef: { recipeId: "inbox-triage", version: "v1" } } : {}),
  };
}

const chatOf = (agentId: string) => `chat_${agentId.slice(4)}`;
const agentOf = (chatId: string) => `bot_${chatId.slice(5)}`;
const runningTask = (chatId: string) => ({
  taskId: "task_aaaaaaaa", chatId, agentId: agentOf(chatId), status: "running", revision: 1, updatedAt: at,
});
const pendingApproval = (chatId: string) => ({
  interactionId: "in_aaaaaaaa", chatId, agentId: agentOf(chatId), taskId: "task_aaaaaaaa",
  kind: "approval", blocking: true, status: "pending", expiresAt: soon, revision: 1,
});

const mounted: (() => void)[] = [];

function renderStatuses(agents: readonly ChatAgent[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    (props: { agents: readonly ChatAgent[] }) => useAgentStatuses(props.agents),
    { wrapper, initialProps: { agents } },
  );
  mounted.push(rendered.unmount);
  return rendered;
}

describe("useAgentStatuses", () => {
  // Which agents are working or waiting on the person right now, by chat.
  let working: string[];
  let waiting: string[];

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    working = [];
    waiting = [];
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
    mockFetchAgentDirectChat.mockImplementation(async (_token: string, _url: string, agentId: string) => chatOf(agentId));
    mockFetchAgentTasks.mockImplementation(async (_token: string, _url: string, chatId: string) =>
      working.includes(chatId) ? [runningTask(chatId)] : []);
    mockFetchAgentInteractions.mockImplementation(async (_token: string, _url: string, chatId: string) =>
      waiting.includes(chatId) ? [pendingApproval(chatId)] : []);
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
    jest.restoreAllMocks();
  });

  it("is loading for every agent until the reads answer, then gives each its status", async () => {
    working = ["chat_working1"];
    waiting = ["chat_waiting1"];
    const agents = [agent("bot_working1"), agent("bot_waiting1"), agent("bot_resting1")];
    const { result } = renderStatuses(agents);

    expect(result.current.statuses.bot_working1).toMatchObject({ state: "loading" });
    expect(result.current.waitingCount).toBe(0);
    await waitFor(() => expect(result.current.statuses.bot_working1).toMatchObject({ state: "working" }));

    expect(result.current.statuses).toEqual({
      bot_working1: { state: "working", label: "Working", chatId: "chat_working1", lastActivityAt: at },
      bot_waiting1: { state: "attention", label: "Approval requested", chatId: "chat_waiting1", lastActivityAt: null },
      bot_resting1: { state: "idle", label: "No open tasks", chatId: "chat_resting1", lastActivityAt: null },
    });
    expect(result.current.waitingCount).toBe(1);
    expect(result.current.isPending).toBe(false);
    expect(mockFetchAgentDirectChat).toHaveBeenCalledWith("session-token", gatewayUrl, "bot_working1");
    expect(mockFetchAgentTasks).toHaveBeenCalledWith("session-token", gatewayUrl, "chat_working1");
    expect(mockFetchAgentInteractions).toHaveBeenCalledWith("session-token", gatewayUrl, "chat_working1");
  });

  it("counts every agent that needs the person", async () => {
    waiting = ["chat_waiting1", "chat_waiting2"];
    mockFetchAgentTasks.mockImplementation(async (_token: string, _url: string, chatId: string) =>
      chatId === "chat_failed01" ? [{ ...runningTask(chatId), status: "blocked", blockedReason: "funds_unavailable" }] : []);
    const { result } = renderStatuses([
      agent("bot_waiting1"), agent("bot_waiting2"), agent("bot_failed01"), agent("bot_resting1"),
    ]);

    await waitFor(() => expect(result.current.waitingCount).toBe(3));
    expect(result.current.statuses.bot_failed01).toMatchObject({ state: "attention", label: "Funds unavailable" });
  });

  it("marks an agent unavailable when its reads fail instead of failing the whole list", async () => {
    mockFetchAgentTasks.mockImplementation(async (_token: string, _url: string, chatId: string) => {
      if (chatId === "chat_broken01") throw new Error("Agent status unavailable. Try again.");
      return [];
    });
    const { result } = renderStatuses([agent("bot_broken01"), agent("bot_healthy1")]);

    await waitFor(() => expect(result.current.statuses.bot_healthy1).toMatchObject({ state: "idle" }));
    expect(result.current.statuses.bot_broken01).toEqual({
      state: "unavailable", label: "Status unavailable", chatId: null, lastActivityAt: null,
    });
    expect(result.current.waitingCount).toBe(0);
  });

  it("marks an agent that is not from a template unavailable without reading anything for it", async () => {
    const { result } = renderStatuses([agent("bot_custom01", false), agent("bot_resting1")]);

    await waitFor(() => expect(result.current.statuses.bot_resting1).toMatchObject({ state: "idle" }));
    expect(result.current.statuses.bot_custom01).toMatchObject({ state: "unavailable" });
    expect(mockFetchAgentDirectChat).toHaveBeenCalledTimes(1);
    expect(mockFetchAgentDirectChat).not.toHaveBeenCalledWith("session-token", gatewayUrl, "bot_custom01");
  });

  it("never has more than four requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async <T,>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return value;
    };
    mockFetchAgentDirectChat.mockImplementation((_token: string, _url: string, agentId: string) => slow(chatOf(agentId)));
    mockFetchAgentTasks.mockImplementation(() => slow([]));
    mockFetchAgentInteractions.mockImplementation(() => slow([]));
    const agents = Array.from({ length: 12 }, (_unused, index) => agent(`bot_agent${String(index).padStart(3, "0")}`));
    const { result } = renderStatuses(agents);

    await waitFor(() => expect(result.current.statuses.bot_agent011).toMatchObject({ state: "idle" }));
    expect(mockFetchAgentDirectChat).toHaveBeenCalledTimes(12);
    expect(mockFetchAgentTasks).toHaveBeenCalledTimes(12);
    expect(mockFetchAgentInteractions).toHaveBeenCalledTimes(12);
    expect(peak).toBe(4);
  });

  it("reads again only when asked, as a screen does on focus", async () => {
    const { result } = renderStatuses([agent("bot_inbox001")]);
    await waitFor(() => expect(result.current.statuses.bot_inbox001).toMatchObject({ state: "idle" }));
    expect(mockFetchAgentDirectChat).toHaveBeenCalledTimes(1);
    waiting = ["chat_inbox001"];

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.statuses.bot_inbox001).toMatchObject({ state: "attention" }));
    expect(result.current.waitingCount).toBe(1);
    expect(mockFetchAgentDirectChat).toHaveBeenCalledTimes(2);
  });

  it("keeps the statuses it has while reading for a list that gained an agent", async () => {
    working = ["chat_working1"];
    let answerNewAgent!: (value: unknown) => void;
    const { result, rerender } = renderStatuses([agent("bot_working1")]);
    await waitFor(() => expect(result.current.statuses.bot_working1).toMatchObject({ state: "working" }));
    mockFetchAgentDirectChat.mockImplementation((_token: string, _url: string, agentId: string) =>
      agentId === "bot_newcomer" ? new Promise((resolve) => { answerNewAgent = resolve; }) : Promise.resolve(chatOf(agentId)));

    rerender({ agents: [agent("bot_working1"), agent("bot_newcomer")] });

    await waitFor(() => expect(mockFetchAgentDirectChat).toHaveBeenCalledWith("session-token", gatewayUrl, "bot_newcomer"));
    expect(result.current.statuses.bot_working1).toMatchObject({ state: "working" });
    expect(result.current.statuses.bot_newcomer).toMatchObject({ state: "loading" });

    await act(async () => {
      answerNewAgent(null);
    });
    await waitFor(() => expect(result.current.statuses.bot_newcomer).toMatchObject({ state: "idle", chatId: null }));
  });

  it("makes no request for an empty list", async () => {
    const { result } = renderStatuses([]);

    await waitFor(() => expect(mockFetchActiveComputer).toHaveBeenCalled());
    expect(result.current.statuses).toEqual({});
    expect(result.current.waitingCount).toBe(0);
    expect(result.current.isPending).toBe(false);
    expect(mockFetchAgentDirectChat).not.toHaveBeenCalled();
  });

  it("marks every agent unavailable without a signed-in account", () => {
    mockSession = { isSignedIn: false, userId: null, token: null };
    const { result } = renderStatuses([agent("bot_inbox001")]);

    expect(result.current.statuses.bot_inbox001).toMatchObject({ state: "unavailable" });
    expect(result.current.isPending).toBe(false);
    expect(mockFetchAgentDirectChat).not.toHaveBeenCalled();
  });

  it("marks every agent unavailable when the session has no token", async () => {
    mockSession.token = null;
    const { result } = renderStatuses([agent("bot_inbox001")]);

    await waitFor(() => expect(result.current.statuses.bot_inbox001).toMatchObject({ state: "unavailable" }));
    expect(mockFetchAgentDirectChat).not.toHaveBeenCalled();
  });
});
