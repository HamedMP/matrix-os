import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useAgents, useArchiveAgent, useEnsureAgentChat } from "../lib/queries/use-agents";
import { AgentRequestError } from "../lib/requests/bots";
import { mobileQueryKeys } from "../lib/requests/query-keys";

const mockFetchActiveComputer = jest.fn();
const mockFetchAgents = jest.fn();
const mockEnsureAgentDirectChat = jest.fn();
const mockArchiveAgent = jest.fn();
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
  AgentRequestError: jest.requireActual("@/lib/requests/bots").AgentRequestError,
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
  ensureAgentDirectChat: (...args: unknown[]) => mockEnsureAgentDirectChat(...args),
  archiveAgent: (...args: unknown[]) => mockArchiveAgent(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const inbox = { id: "bot_inbox001", name: "Inbox helper", revision: 3, archived: false };
const brief = { id: "bot_brief001", name: "Daily brief", revision: 1, archived: false };

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const mounted: (() => void)[] = [];
const readChats = jest.fn();

function renderAgents() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => {
    // Stand-in for the chat list, which gains a chat when an agent's is created.
    const chats = useQuery({
      queryKey: mobileQueryKeys.canonicalChats("user_a", "alice:primary"),
      queryFn: () => readChats(),
    });
    return { list: useAgents(), ensure: useEnsureAgentChat(), archive: useArchiveAgent(), chats: chats.data };
  }, { wrapper });
  mounted.push(rendered.unmount);
  return rendered;
}

/** The archive action alone, as on a screen that does not itself show the list. */
async function renderArchiveOnly() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => useArchiveAgent(), { wrapper });
  mounted.push(rendered.unmount);
  await waitFor(() => expect(client.getQueryData(mobileQueryKeys.activeComputer("user_a"))).toBeTruthy());
  return { ...rendered, client };
}

const names = (result: { current: { list: { agents: { name: string }[] } } }) =>
  result.current.list.agents.map((agent) => agent.name);

describe("agent hooks", () => {
  // What the server would list right now; every request below moves it.
  let serverAgents: typeof inbox[];

  beforeEach(() => {
    jest.resetAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    serverAgents = [inbox, brief];
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
    mockFetchAgents.mockImplementation(async () => ({ enabled: true, agents: serverAgents }));
    readChats.mockResolvedValue("chats v1");
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
  });

  describe("useAgents", () => {
    it("lists the agents of the active computer", async () => {
      const { result } = renderAgents();

      expect(result.current.list.isPending).toBe(true);
      expect(result.current.list.agentsEnabled).toBeNull();
      await waitFor(() => expect(names(result)).toEqual(["Inbox helper", "Daily brief"]));
      expect(result.current.list.agentsEnabled).toBe(true);
      expect(result.current.list.isPending).toBe(false);
      expect(mockFetchAgents).toHaveBeenCalledWith("session-token", gatewayUrl);
    });

    it("says so when agents are switched off on this computer", async () => {
      mockFetchAgents.mockResolvedValue({ enabled: false, agents: [] });
      const { result } = renderAgents();

      await waitFor(() => expect(result.current.list.agentsEnabled).toBe(false));
      expect(result.current.list.agents).toEqual([]);
      expect(result.current.list.isError).toBe(false);
    });

    it("reads the list again when asked, as a screen does on focus", async () => {
      const { result } = renderAgents();
      await waitFor(() => expect(names(result)).toEqual(["Inbox helper", "Daily brief"]));
      serverAgents = [brief];

      await act(async () => {
        await result.current.list.refetch();
      });

      await waitFor(() => expect(names(result)).toEqual(["Daily brief"]));
    });

    it("reports a list that cannot be loaded", async () => {
      mockFetchAgents.mockRejectedValue(new Error("Agents unavailable. Try again."));
      const { result } = renderAgents();

      await waitFor(() => expect(result.current.list.isError).toBe(true));
      expect(result.current.list.agents).toEqual([]);
    });

    it("stays idle without a signed-in account", () => {
      mockSession = { isSignedIn: false, userId: null, token: null };
      const { result } = renderAgents();

      expect(result.current.list.isPending).toBe(false);
      expect(mockFetchAgents).not.toHaveBeenCalled();
    });
  });

  describe("useEnsureAgentChat", () => {
    it("returns the agent's chat and reads the chat list again, since the chat may be new", async () => {
      mockEnsureAgentDirectChat.mockResolvedValue("chat_inbox");
      const { result } = renderAgents();
      await waitFor(() => expect(result.current.chats).toBe("chats v1"));
      await waitFor(() => expect(names(result)).toHaveLength(2));
      readChats.mockResolvedValue("chats v2");

      await act(async () => {
        await expect(result.current.ensure.mutateAsync("bot_inbox001")).resolves.toBe("chat_inbox");
      });

      expect(mockEnsureAgentDirectChat).toHaveBeenCalledWith("session-token", gatewayUrl, "bot_inbox001");
      await waitFor(() => expect(result.current.chats).toBe("chats v2"));
    });

    it("passes on why a chat could not be opened", async () => {
      mockEnsureAgentDirectChat.mockRejectedValue(new AgentRequestError("not_found"));
      const { result } = renderAgents();
      await waitFor(() => expect(names(result)).toHaveLength(2));

      await act(async () => {
        await expect(result.current.ensure.mutateAsync("bot_inbox001")).rejects.toMatchObject({ reason: "not_found" });
      });
    });

    it("does not call the server when the session has no token", async () => {
      const { result } = renderAgents();
      await waitFor(() => expect(names(result)).toHaveLength(2));
      mockSession.token = null;

      await act(async () => {
        await expect(result.current.ensure.mutateAsync("bot_inbox001")).rejects.toMatchObject({ reason: "unavailable" });
      });

      expect(mockEnsureAgentDirectChat).not.toHaveBeenCalled();
    });
  });

  describe("useArchiveAgent", () => {
    it("removes the agent from the list only once the server has archived it", async () => {
      let confirm!: (value: unknown) => void;
      mockArchiveAgent.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
      const { result } = renderAgents();
      await waitFor(() => expect(names(result)).toEqual(["Inbox helper", "Daily brief"]));

      let request!: Promise<unknown>;
      act(() => { request = result.current.archive.mutateAsync({ agentId: "bot_inbox001", baseRevision: 3 }); });
      await waitFor(() => expect(result.current.archive.isPending).toBe(true));
      expect(names(result)).toEqual(["Inbox helper", "Daily brief"]);

      await act(async () => {
        serverAgents = [brief];
        confirm({ ...inbox, revision: 4, archived: true });
        await request;
      });

      await waitFor(() => expect(names(result)).toEqual(["Daily brief"]));
      expect(mockArchiveAgent).toHaveBeenCalledWith("session-token", gatewayUrl, "bot_inbox001", 3);
    });

    it("shows the agent gone before the list has been read again", async () => {
      mockArchiveAgent.mockResolvedValue({ ...inbox, revision: 4, archived: true });
      const { result } = renderAgents();
      await waitFor(() => expect(names(result)).toEqual(["Inbox helper", "Daily brief"]));
      // The re-read after the request never answers in this test.
      mockFetchAgents.mockReturnValue(new Promise(() => {}));

      await act(async () => {
        await result.current.archive.mutateAsync({ agentId: "bot_inbox001", baseRevision: 3 });
      });

      await waitFor(() => expect(names(result)).toEqual(["Daily brief"]));
      expect(result.current.list.agentsEnabled).toBe(true);
    });

    it("keeps the agent on a revision conflict and loads its current revision for the next try", async () => {
      mockArchiveAgent.mockRejectedValue(new AgentRequestError("conflict"));
      const { result } = renderAgents();
      await waitFor(() => expect(names(result)).toEqual(["Inbox helper", "Daily brief"]));
      // Someone renamed the agent elsewhere, which moved its revision on.
      serverAgents = [{ ...inbox, name: "Inbox triage", revision: 4 }, brief];

      await act(async () => {
        await expect(result.current.archive.mutateAsync({ agentId: "bot_inbox001", baseRevision: 3 }))
          .rejects.toMatchObject({ reason: "conflict" });
      });

      await waitFor(() => expect(names(result)).toEqual(["Inbox triage", "Daily brief"]));
      expect(result.current.list.agents[0]!.revision).toBe(4);
      await waitFor(() => expect(result.current.archive.error).toMatchObject({ reason: "conflict" }));
    });

    it("does not let a list read that was already in flight bring the agent back", async () => {
      let answerEarlierRead!: (value: unknown) => void;
      mockFetchAgents
        .mockResolvedValueOnce({ enabled: true, agents: [inbox, brief] })
        .mockReturnValueOnce(new Promise((resolve) => { answerEarlierRead = resolve; }));
      mockArchiveAgent.mockImplementation(async () => {
        serverAgents = [brief];
        return { ...inbox, revision: 4, archived: true };
      });
      const { result } = renderAgents();
      await waitFor(() => expect(names(result)).toEqual(["Inbox helper", "Daily brief"]));
      act(() => { void result.current.list.refetch(); });
      await waitFor(() => expect(mockFetchAgents).toHaveBeenCalledTimes(2));

      await act(async () => {
        await result.current.archive.mutateAsync({ agentId: "bot_inbox001", baseRevision: 3 });
      });
      await act(async () => {
        answerEarlierRead({ enabled: true, agents: [inbox, brief] });
      });

      await waitFor(() => expect(mockFetchAgents).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(names(result)).toEqual(["Daily brief"]));
    });

    it("does not let an earlier list read bring the agent back while no screen is showing the list", async () => {
      // With nothing showing the list, nothing reads it again after the request,
      // so an older read still in flight would otherwise have the last word.
      mockArchiveAgent.mockResolvedValue({ ...inbox, revision: 4, archived: true });
      const { result, client } = await renderArchiveOnly();
      const agentsKey = mobileQueryKeys.agents("user_a", "alice:primary");
      client.setQueryData(agentsKey, { enabled: true, agents: [inbox, brief] });
      let answerEarlierRead!: (value: unknown) => void;
      const earlierRead = client.fetchQuery({
        queryKey: agentsKey,
        queryFn: () => new Promise((resolve) => { answerEarlierRead = resolve; }),
      });
      earlierRead.catch(() => {});
      await waitFor(() => expect(client.isFetching({ queryKey: agentsKey })).toBe(1));

      await act(async () => {
        await result.current.mutateAsync({ agentId: "bot_inbox001", baseRevision: 3 });
      });
      await act(async () => {
        answerEarlierRead({ enabled: true, agents: [inbox, brief] });
      });

      expect(client.getQueryData(agentsKey)).toEqual({ enabled: true, agents: [brief] });
      // Still due a fresh read the next time a screen shows the list.
      expect(client.getQueryState(agentsKey)?.isInvalidated).toBe(true);
    });
  });
});
