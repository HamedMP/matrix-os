import { act, renderHook } from "@testing-library/react-native";

const mockGetToken = jest.fn();
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: mockGetToken }) }));
// jest.setup.js replaces the hook for screen tests; this suite is about the real one.
jest.unmock("@/lib/use-session-token-warmup");

import { sessionTokenTimeLeftMs, useSessionTokenWarmup } from "../lib/use-session-token-warmup";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

/** A JWT-shaped token that expires `secondsLeft` from NOW. Only its payload is meaningful. */
function tokenExpiringIn(secondsLeft: number): string {
  const payload = btoa(JSON.stringify({ exp: NOW / 1000 + secondsLeft }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${payload}.signature`;
}

const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(0); });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("sessionTokenTimeLeftMs", () => {
  it("reads the time left from the token's expiry", () => {
    expect(sessionTokenTimeLeftMs(tokenExpiringIn(42), NOW)).toBe(42_000);
  });

  it("is 0 for an expired token and for anything it cannot read", () => {
    expect(sessionTokenTimeLeftMs(tokenExpiringIn(-5), NOW)).toBe(0);
    expect(sessionTokenTimeLeftMs("not-a-token", NOW)).toBe(0);
    expect(sessionTokenTimeLeftMs(`header.${btoa("{}")}.signature`, NOW)).toBe(0);
  });
});

describe("useSessionTokenWarmup", () => {
  it("leaves a token with plenty of time left alone", async () => {
    mockGetToken.mockResolvedValue(tokenExpiringIn(55));
    const { result } = renderHook(() => useSessionTokenWarmup());

    result.current();
    await settle();

    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(mockGetToken).toHaveBeenCalledWith();
  });

  it("replaces a token that would run out before a send", async () => {
    mockGetToken.mockResolvedValue(tokenExpiringIn(12));
    const { result } = renderHook(() => useSessionTokenWarmup());

    result.current();
    await settle();

    expect(mockGetToken).toHaveBeenLastCalledWith({ skipCache: true });
  });

  it("replaces a token it cannot read rather than assume it is valid", async () => {
    mockGetToken.mockResolvedValue("opaque-session-token");
    const { result } = renderHook(() => useSessionTokenWarmup());

    result.current();
    await settle();

    expect(mockGetToken).toHaveBeenLastCalledWith({ skipCache: true });
  });

  it("looks at most once per interval however often it is called", async () => {
    mockGetToken.mockResolvedValue(tokenExpiringIn(55));
    const { result } = renderHook(() => useSessionTokenWarmup());

    result.current();
    result.current();
    await settle();
    expect(mockGetToken).toHaveBeenCalledTimes(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(15_000); });
    result.current();
    await settle();
    expect(mockGetToken).toHaveBeenCalledTimes(2);
  });

  it("tries again on the next call after a failed refresh", async () => {
    mockGetToken.mockRejectedValueOnce(new Error("network")).mockResolvedValue(tokenExpiringIn(55));
    const { result } = renderHook(() => useSessionTokenWarmup());

    result.current();
    await settle();
    result.current();
    await settle();

    expect(mockGetToken).toHaveBeenCalledTimes(2);
  });
});
