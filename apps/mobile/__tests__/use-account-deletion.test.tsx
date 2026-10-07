const mockFetchStatus = jest.fn();
const mockSchedule = jest.fn();
const mockCancel = jest.fn();
const mockFetchExportFiles = jest.fn();
const mockFetchRecords = jest.fn();
let mockSession: { isSignedIn: boolean; userId: string | null; token: string | null };

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: mockSession.isSignedIn,
    userId: mockSession.userId,
    getToken: async () => mockSession.token,
  }),
}));

jest.mock("@/lib/requests", () => {
  class AccountDeletionRequestError extends Error {
    reason: string;
    constructor(failure: string) {
      super(failure);
      this.name = "AccountDeletionRequestError";
      this.reason = failure;
    }
  }
  return {
    AccountDeletionRequestError,
    mobileQueryKeys: { accountDeletion: (userId: string) => ["account-deletion", userId] },
    fetchAccountDeletionStatus: (...args: unknown[]) => mockFetchStatus(...args),
    scheduleAccountDeletion: (...args: unknown[]) => mockSchedule(...args),
    cancelAccountDeletion: (...args: unknown[]) => mockCancel(...args),
    fetchAccountExportFiles: (...args: unknown[]) => mockFetchExportFiles(...args),
    fetchAccountRecords: (...args: unknown[]) => mockFetchRecords(...args),
  };
});

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useAccountDeletion, useAccountExport } from "../lib/queries/use-account-deletion";

const none = { status: "none", erasesAfter: null, completesBy: null, billingStopped: false };
const scheduled = {
  status: "scheduled",
  erasesAfter: "2026-10-11T12:00:00.000Z",
  completesBy: "2026-10-12T12:00:00.000Z",
  billingStopped: true,
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

describe("useAccountDeletion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    mockFetchStatus.mockResolvedValue(none);
  });

  it("loads the state for the signed-in account", async () => {
    const { result } = renderHook(() => useAccountDeletion(), { wrapper });

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(result.current.status).toEqual(none));
    expect(mockFetchStatus).toHaveBeenCalledWith("session-token");
    expect(result.current.enabled).toBe(true);
  });

  it("stays idle without a Matrix OS account session", () => {
    mockSession = { isSignedIn: false, userId: null, token: null };
    const { result } = renderHook(() => useAccountDeletion(), { wrapper });

    expect(result.current.enabled).toBe(false);
    expect(result.current.isPending).toBe(false);
    expect(mockFetchStatus).not.toHaveBeenCalled();
  });

  it("shows the scheduled state only once the server has confirmed it", async () => {
    let confirm!: (value: unknown) => void;
    mockSchedule.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
    const { result } = renderHook(() => useAccountDeletion(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(none));

    let request!: Promise<unknown>;
    act(() => { request = result.current.schedule(); });
    await waitFor(() => expect(result.current.isScheduling).toBe(true));
    expect(result.current.status).toEqual(none);

    await act(async () => {
      confirm(scheduled);
      await request;
    });
    await waitFor(() => expect(result.current.status).toEqual(scheduled));
    expect(mockSchedule).toHaveBeenCalledWith("session-token");
  });

  it("keeps the previous state when scheduling fails", async () => {
    mockSchedule.mockRejectedValue(new Error("refused"));
    const { result } = renderHook(() => useAccountDeletion(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(none));

    await act(async () => {
      await expect(result.current.schedule()).rejects.toThrow("refused");
    });

    expect(result.current.status).toEqual(none);
  });

  it("stores the state the server returns for a cancellation", async () => {
    const cancelled = { ...none, status: "cancelled", billingStopped: true };
    mockFetchStatus.mockResolvedValue(scheduled);
    mockCancel.mockResolvedValue(cancelled);
    const { result } = renderHook(() => useAccountDeletion(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(scheduled));

    await act(async () => {
      await result.current.cancel();
    });

    await waitFor(() => expect(result.current.status).toEqual(cancelled));
    // The answer comes from the mutation itself, not from a second read.
    expect(mockFetchStatus).toHaveBeenCalledTimes(1);
  });

  it("does not call the server when the session has no token", async () => {
    const { result } = renderHook(() => useAccountDeletion(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(none));
    mockSession.token = null;

    await act(async () => {
      await expect(result.current.schedule()).rejects.toMatchObject({ reason: "unavailable" });
    });

    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe("useAccountExport", () => {
  const firstPage = {
    files: [{ name: "a", url: "https://storage.example/a" }],
    instructions: ["Download every page."],
    nextCursor: "page-2",
  };
  const secondPage = {
    files: [{ name: "b", url: "https://storage.example/b" }],
    instructions: ["Download every page."],
    nextCursor: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
  });

  it("has no list until it is requested", () => {
    const { result } = renderHook(() => useAccountExport(), { wrapper });

    expect(result.current.files).toBeNull();
    expect(result.current.hasMoreFiles).toBe(false);
    expect(mockFetchExportFiles).not.toHaveBeenCalled();
  });

  it("appends further pages and stops when there are none left", async () => {
    mockFetchExportFiles.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    const { result } = renderHook(() => useAccountExport(), { wrapper });

    await act(async () => {
      await result.current.loadFiles();
    });
    expect(result.current.files).toEqual(firstPage.files);
    expect(result.current.instructions).toEqual(["Download every page."]);
    expect(result.current.hasMoreFiles).toBe(true);
    expect(mockFetchExportFiles).toHaveBeenLastCalledWith("session-token", undefined);

    await act(async () => {
      await result.current.loadMoreFiles();
    });
    expect(mockFetchExportFiles).toHaveBeenLastCalledWith("session-token", "page-2");
    expect(result.current.files).toEqual([...firstPage.files, ...secondPage.files]);
    expect(result.current.hasMoreFiles).toBe(false);
  });

  it("replaces the list when it is requested again, because the old links expire", async () => {
    const fresh = { ...firstPage, files: [{ name: "a", url: "https://storage.example/a?fresh=1" }] };
    mockFetchExportFiles.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(fresh);
    const { result } = renderHook(() => useAccountExport(), { wrapper });

    await act(async () => {
      await result.current.loadFiles();
    });
    await act(async () => {
      await result.current.loadFiles();
    });

    expect(result.current.files).toEqual(fresh.files);
  });

  it("keeps the loaded list when a further page fails", async () => {
    mockFetchExportFiles.mockResolvedValueOnce(firstPage).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useAccountExport(), { wrapper });

    await act(async () => {
      await result.current.loadFiles();
    });
    await act(async () => {
      await expect(result.current.loadMoreFiles()).rejects.toThrow("offline");
    });

    expect(result.current.files).toEqual(firstPage.files);
    expect(result.current.hasMoreFiles).toBe(true);
  });

  it("fetches the account records with the session token", async () => {
    mockFetchRecords.mockResolvedValue('{"version":1}');
    const { result } = renderHook(() => useAccountExport(), { wrapper });

    let records: unknown;
    await act(async () => {
      records = await result.current.fetchRecords();
    });

    expect(records).toBe('{"version":1}');
    expect(mockFetchRecords).toHaveBeenCalledWith("session-token");
  });
});
