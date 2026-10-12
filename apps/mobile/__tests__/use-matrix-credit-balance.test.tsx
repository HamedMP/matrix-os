import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useMatrixCreditBalance } from "../lib/queries/use-matrix-credit-balance";

const mockFetchActiveComputer = jest.fn();
const mockFetchMatrixCreditBalance = jest.fn();
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
  formatMicrousd: jest.requireActual("@/lib/requests/matrix-credit").formatMicrousd,
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  fetchMatrixCreditBalance: (...args: unknown[]) => mockFetchMatrixCreditBalance(...args),
}));

notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const mounted: (() => void)[] = [];

function renderBalance() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => useMatrixCreditBalance(), { wrapper });
  mounted.push(rendered.unmount);
  return rendered;
}

describe("useMatrixCreditBalance", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
    mockFetchMatrixCreditBalance.mockResolvedValue(18_400_000);
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
  });

  it("loads the balance of the active computer and formats it in dollars", async () => {
    const { result } = renderBalance();

    expect(result.current.isPending).toBe(true);
    expect(result.current.balanceMicrousd).toBeNull();
    expect(result.current.label).toBeNull();
    await waitFor(() => expect(result.current.balanceMicrousd).toBe(18_400_000));
    expect(result.current.label).toBe("$18.40");
    expect(result.current.isPending).toBe(false);
    expect(mockFetchMatrixCreditBalance).toHaveBeenCalledWith("session-token", "https://app.matrix-os.com/vm/alice");
  });

  it("has no label when the server reports no balance", async () => {
    mockFetchMatrixCreditBalance.mockResolvedValue(null);
    const { result } = renderBalance();

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.balanceMicrousd).toBeNull();
    expect(result.current.label).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("shows a zero balance as zero", async () => {
    mockFetchMatrixCreditBalance.mockResolvedValue(0);
    const { result } = renderBalance();

    await waitFor(() => expect(result.current.label).toBe("$0.00"));
    expect(result.current.balanceMicrousd).toBe(0);
  });

  it("reads the balance again when asked, as a screen does on focus", async () => {
    const { result } = renderBalance();
    await waitFor(() => expect(result.current.label).toBe("$18.40"));
    mockFetchMatrixCreditBalance.mockResolvedValue(17_150_000);

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.label).toBe("$17.15"));
    expect(mockFetchMatrixCreditBalance).toHaveBeenCalledTimes(2);
  });

  it("reports a failed read and shows no figure", async () => {
    mockFetchMatrixCreditBalance.mockRejectedValue(new Error("Credit balance unavailable. Try again."));
    const { result } = renderBalance();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.balanceMicrousd).toBeNull();
    expect(result.current.label).toBeNull();
  });

  it("stays idle without a signed-in account", () => {
    mockSession = { isSignedIn: false, userId: null, token: null };
    const { result } = renderBalance();

    expect(result.current.isPending).toBe(false);
    expect(result.current.balanceMicrousd).toBeNull();
    expect(mockFetchMatrixCreditBalance).not.toHaveBeenCalled();
  });
});
