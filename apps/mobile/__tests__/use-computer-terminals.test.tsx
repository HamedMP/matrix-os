const mockFetchActiveComputer = jest.fn();
const mockFetchTerminalSessions = jest.fn();
const mockCreateTerminalSession = jest.fn();
const mockRenameTerminalSession = jest.fn();
const mockDeleteTerminalSession = jest.fn();
const mockNextName = jest.fn();
let mockSession: { isSignedIn: boolean; userId: string | null; token: string | null };
const mockGetToken = async () => mockSession.token;

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: mockSession.isSignedIn,
    userId: mockSession.userId,
    getToken: mockGetToken,
  }),
}));

jest.mock("@/lib/requests", () => ({
  mobileQueryKeys: {
    activeComputer: (userId: string) => ["active-computer", userId],
    terminals: (userId: string, computerKey: string) => ["terminals", userId, computerKey],
  },
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  fetchTerminalSessions: (...args: unknown[]) => mockFetchTerminalSessions(...args),
  createTerminalSession: (...args: unknown[]) => mockCreateTerminalSession(...args),
  renameTerminalSession: (...args: unknown[]) => mockRenameTerminalSession(...args),
  deleteTerminalSession: (...args: unknown[]) => mockDeleteTerminalSession(...args),
}));

jest.mock("@/lib/shell-session-names", () => ({
  SHELL_SESSION_CREATE_ATTEMPTS: 3,
  twoWordShellSessionName: () => mockNextName(),
}));

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";

import { useComputerTerminals } from "../lib/queries/use-computer-terminals";
import { createTerminalSession } from "../lib/requests/terminals";
import { disposeTestQueryClient } from "./query-test-cleanup";

const COMPUTER_URL = "https://app.matrix-os.com/vm/solar-vale";
const WORKSPACE = "tws_00000000000000000000000000000001";
const TAB = "tt_0000000000000000000000000000000a";
const session = {
  id: `${WORKSPACE}:${TAB}`,
  workspaceId: WORKSPACE,
  tabId: TAB,
  revision: 3,
  name: "swift-falcon",
  cwd: "projects",
  status: "active",
  visualStatus: "running",
};

// Query results are delivered through React's act() so that every state change
// they cause is flushed before the next assertion.
notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(async () => {
  cleanup();
  await disposeTestQueryClient(client);
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useComputerTerminals", () => {
  // What the computer would list right now; the mutations below move it.
  let serverSessions: unknown[];

  beforeEach(() => {
    jest.resetAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    serverSessions = [session];
    mockFetchActiveComputer.mockResolvedValue({
      handle: "solar-vale",
      runtimeSlot: "primary",
      gatewayPath: "/vm/solar-vale",
    });
    mockFetchTerminalSessions.mockImplementation(async () => serverSessions);
    mockNextName.mockReturnValue("calm-otter");
  });

  it("lists the terminals of the selected computer", async () => {
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(result.current.sessions).toEqual([session]));
    expect(mockFetchTerminalSessions).toHaveBeenCalledWith(mockGetToken, COMPUTER_URL);
    expect(result.current.isError).toBe(false);
  });

  it("reports terminals as unavailable when the first load fails", async () => {
    mockFetchTerminalSessions.mockRejectedValue(new Error("Terminals unavailable. Try again."));
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.isPending).toBe(false);
  });

  it("keeps the last list on screen when a later refresh fails", async () => {
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    mockFetchTerminalSessions.mockRejectedValue(new Error("Terminals unavailable. Try again."));
    await act(async () => { await result.current.refresh(); });

    expect(result.current.sessions).toEqual([session]);
    expect(result.current.isError).toBe(false);
  });

  it("keeps listing terminals when the computer inventory fails to refresh", async () => {
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    mockFetchActiveComputer.mockRejectedValue(new Error("Computers unavailable. Try again."));
    await act(async () => { await result.current.refresh(); });

    expect(result.current.sessions).toEqual([session]);
    expect(result.current.isError).toBe(false);
  });

  it("reports terminals as unavailable when the computer could not be resolved", async () => {
    mockFetchActiveComputer.mockRejectedValue(new Error("Computers unavailable. Try again."));
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockFetchTerminalSessions).not.toHaveBeenCalled();
  });

  it("creates a terminal under a name the list is not already showing", async () => {
    mockNextName.mockReturnValueOnce("swift-falcon").mockReturnValueOnce("calm-otter");
    mockCreateTerminalSession.mockResolvedValue(`${WORKSPACE}:tt_0000000000000000000000000000000b`);
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    let created: string | undefined;
    await act(async () => { created = await result.current.createSession(); });

    expect(created).toBe(`${WORKSPACE}:tt_0000000000000000000000000000000b`);
    expect(mockCreateTerminalSession).toHaveBeenCalledWith(mockGetToken, COMPUTER_URL, "calm-otter");
  });

  it("renews the bearer after the workspace wakes and uses it to create the tab", async () => {
    mockCreateTerminalSession.mockImplementationOnce(createTerminalSession);
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));
    jest.useFakeTimers();
    const random = jest.spyOn(Math, "random").mockReturnValue(0);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const observed: Array<{ url: string; bearer: string }> = [];
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const bearer = (init?.headers as Record<string, string>).Authorization;
      observed.push({ url, bearer });
      if (observed.length === 1) return {
        status: 503,
        headers: { get: (name: string) => name === "retry-after" ? "1" : null },
        clone: () => ({ text: async () => '{"runtimeState":"waking"}' }),
      } as unknown as Response;
      if (bearer !== "Bearer renewed") return { status: 401, ok: false } as Response;
      const time = "2026-11-26T00:00:00.000Z";
      const body = url.endsWith("/ensure")
        ? { workspace: { id: WORKSPACE, scope: "main", tabs: [] } }
        : { tab: {
          id: TAB, workspaceId: WORKSPACE, name: "calm-otter", cwd: "projects", revision: 1,
          order: 0, status: "running", accessScope: "owner", createdAt: time, updatedAt: time,
        } };
      return { status: 200, ok: true, json: async () => body } as Response;
    });
    try {
      await act(async () => {
        const creation = result.current.createSession().catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(500);
        mockSession.token = "renewed";
        await jest.advanceTimersByTimeAsync(500);

        expect(await creation).toBe(`${WORKSPACE}:${TAB}`);
      });
      expect(observed).toEqual([
        { url: `${COMPUTER_URL}/api/terminal/workspaces/ensure`, bearer: "Bearer session-token" },
        { url: `${COMPUTER_URL}/api/terminal/workspaces/ensure`, bearer: "Bearer renewed" },
        { url: `${COMPUTER_URL}/api/terminal/workspaces/${WORKSPACE}/tabs`, bearer: "Bearer renewed" },
      ]);
    } finally {
      fetchMock.mockRestore();
      random.mockRestore();
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it("still creates a terminal when every generated name is already in the list", async () => {
    mockNextName.mockReturnValue("swift-falcon");
    mockCreateTerminalSession.mockResolvedValue(`${WORKSPACE}:tt_0000000000000000000000000000000b`);
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    await act(async () => { await result.current.createSession(); });

    expect(mockNextName).toHaveBeenCalledTimes(3);
    expect(mockCreateTerminalSession).toHaveBeenCalledWith(mockGetToken, COMPUTER_URL, "swift-falcon");
  });

  it("renames against the listed revision and shows the new name once reloaded", async () => {
    mockRenameTerminalSession.mockImplementation(async () => {
      serverSessions = [{ ...session, name: "Deploy logs", revision: 4 }];
    });
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    await act(async () => { await result.current.renameSession(result.current.sessions[0]!, "Deploy logs"); });

    expect(mockRenameTerminalSession).toHaveBeenCalledWith(mockGetToken, COMPUTER_URL, session, "Deploy logs");
    await waitFor(() => expect(result.current.sessions).toEqual([{ ...session, name: "Deploy logs", revision: 4 }]));
  });

  it("reloads the list after a refused rename so the next attempt uses the current revision", async () => {
    mockRenameTerminalSession.mockRejectedValue(new Error("Could not rename terminal. Try again."));
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));
    serverSessions = [{ ...session, revision: 7 }];

    await act(async () => {
      await expect(result.current.renameSession(result.current.sessions[0]!, "Deploy logs"))
        .rejects.toThrow("Could not rename terminal. Try again.");
    });

    await waitFor(() => expect(result.current.sessions[0]?.revision).toBe(7));
  });

  it("removes a deleted terminal from the list once the computer confirms", async () => {
    mockDeleteTerminalSession.mockImplementation(async () => { serverSessions = []; });
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    await act(async () => { await result.current.deleteSession(result.current.sessions[0]!); });

    expect(mockDeleteTerminalSession).toHaveBeenCalledWith(mockGetToken, COMPUTER_URL, session);
    await waitFor(() => expect(result.current.sessions).toEqual([]));
  });

  it("keeps a terminal listed when deleting it fails", async () => {
    mockDeleteTerminalSession.mockRejectedValue(new Error("Could not delete terminal. Try again."));
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    await act(async () => {
      await expect(result.current.deleteSession(result.current.sessions[0]!))
        .rejects.toThrow("Could not delete terminal. Try again.");
    });

    expect(result.current.sessions).toEqual([session]);
  });

  it("stays idle without a Matrix OS account session", () => {
    mockSession = { isSignedIn: false, userId: null, token: null };
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });

    expect(result.current.isPending).toBe(false);
    expect(mockFetchActiveComputer).not.toHaveBeenCalled();
    expect(mockFetchTerminalSessions).not.toHaveBeenCalled();
  });
});
