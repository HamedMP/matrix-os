const mockFetchActiveComputer = jest.fn();
const mockFetchTerminalSessions = jest.fn();
const mockCreateTerminalSession = jest.fn();
const mockRenameTerminalSession = jest.fn();
const mockDeleteTerminalSession = jest.fn();
const mockNextName = jest.fn();
let mockSession: { isSignedIn: boolean; userId: string | null; token: string | null };

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: mockSession.isSignedIn,
    userId: mockSession.userId,
    getToken: async () => mockSession.token,
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
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useComputerTerminals } from "../lib/queries/use-computer-terminals";

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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
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
    expect(mockFetchTerminalSessions).toHaveBeenCalledWith("session-token", COMPUTER_URL);
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
    expect(mockCreateTerminalSession).toHaveBeenCalledWith("session-token", COMPUTER_URL, "calm-otter");
  });

  it("still creates a terminal when every generated name is already in the list", async () => {
    mockNextName.mockReturnValue("swift-falcon");
    mockCreateTerminalSession.mockResolvedValue(`${WORKSPACE}:tt_0000000000000000000000000000000b`);
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    await act(async () => { await result.current.createSession(); });

    expect(mockNextName).toHaveBeenCalledTimes(3);
    expect(mockCreateTerminalSession).toHaveBeenCalledWith("session-token", COMPUTER_URL, "swift-falcon");
  });

  it("renames against the listed revision and shows the new name once reloaded", async () => {
    mockRenameTerminalSession.mockImplementation(async () => {
      serverSessions = [{ ...session, name: "Deploy logs", revision: 4 }];
    });
    const { result } = renderHook(() => useComputerTerminals(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toEqual([session]));

    await act(async () => { await result.current.renameSession(result.current.sessions[0]!, "Deploy logs"); });

    expect(mockRenameTerminalSession).toHaveBeenCalledWith("session-token", COMPUTER_URL, session, "Deploy logs");
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

    expect(mockDeleteTerminalSession).toHaveBeenCalledWith("session-token", COMPUTER_URL, session);
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
