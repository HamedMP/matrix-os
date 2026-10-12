const mockGetToken = jest.fn(async () => "owner-token");
const mockUseQuery = jest.fn();
const mockCreateAppSession = jest.fn(async (_token: string, _gateway: string, _slug: string) => ({ launchUrl: "/apps/chess/?session=fixture" }));
const mockFetchInstalledApps = jest.fn();

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: mockGetToken, isLoaded: true, isSignedIn: true, userId: "owner" }),
}));
jest.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => mockUseQuery(options) }));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("@/lib/requests", () => ({
  createAppSession: (...args: [string, string, string]) => mockCreateAppSession(...args),
  fetchActiveComputer: jest.fn(), fetchInstalledApps: (...args: [string, string]) => mockFetchInstalledApps(...args),
  mobileQueryKeys: {
    activeComputer: (owner: string) => ["computer", owner],
    appSession: (owner: string, computer: string, app: string) => ["session", owner, computer, app],
  },
}));
jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
  resolveMobileAppSessionLaunchUrl: (gateway: string, path: string) => gateway + path,
}));

import { renderHook } from "@testing-library/react-native";
import { installedAppSlug, useComputerAppSession } from "../lib/queries/use-computer-apps";

describe("installed app identity and runtime sessions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchInstalledApps.mockResolvedValue([{ name: "Chess", slug: "chess", file: "games/chess/index.html", path: "/files/apps/games/chess/index.html" }]);
    mockUseQuery.mockReturnValueOnce({ data: { handle: "fixture", runtimeSlot: "live", gatewayPath: "/vm/fixture" } })
      .mockReturnValueOnce({ data: { launchUrl: "/apps/chess/?session=fixture" } });
  });

  it("launches the migrated runtime while keeping the full installed identity in the launcher and session cache", async () => {
    const identity = installedAppSlug({ name: "Chess", slug: "chess", file: "games/chess/index.html", path: "/files/apps/games/chess/index.html" });
    expect(identity).toBe("games/chess");
    const { unmount } = renderHook(() => useComputerAppSession(identity));
    const session = mockUseQuery.mock.calls[1][0];
    expect(session.queryKey).toEqual(["session", "owner", "fixture:live", "games/chess", "catalog"]);
    await session.queryFn();
    expect(mockCreateAppSession).toHaveBeenCalledWith("owner-token", "https://app.matrix-os.com/vm/fixture", "chess");
    unmount();
  });

  it("rejects an uncataloged nested app instead of guessing its leaf runtime", async () => {
    const { unmount } = renderHook(() => useComputerAppSession("private/chess"));
    await expect(mockUseQuery.mock.calls[1][0].queryFn()).rejects.toThrow("App session unavailable");
    expect(mockCreateAppSession).not.toHaveBeenCalled();
    unmount();
  });

  it("uses the exact authenticated catalog pair for arbitrary nested apps", async () => {
    mockFetchInstalledApps.mockResolvedValue([{ name: "Timer", slug: "timer", file: "tools/timer/index.html", path: "/files/apps/tools/timer/index.html" }]);
    mockCreateAppSession.mockResolvedValueOnce({ launchUrl: "/apps/timer/?session=fixture" });
    const { unmount } = renderHook(() => useComputerAppSession("tools/timer", "timer"));
    const session = mockUseQuery.mock.calls[1][0];
    expect(session.queryKey).toEqual(["session", "owner", "fixture:live", "tools/timer", "timer"]);
    await expect(session.queryFn()).resolves.toEqual({ launchUrl: "/apps/timer/?session=fixture", appIdentity: "tools/timer", runtimeSlug: "timer" });
    expect(mockFetchInstalledApps).toHaveBeenCalledWith("owner-token", "https://app.matrix-os.com/vm/fixture");
    expect(mockCreateAppSession).toHaveBeenCalledWith("owner-token", "https://app.matrix-os.com/vm/fixture", "timer");
    unmount();
  });

  it("rejects a deep-link alias that disagrees with the authenticated catalog", async () => {
    const { unmount } = renderHook(() => useComputerAppSession("games/chess", "notes"));
    await expect(mockUseQuery.mock.calls[1][0].queryFn()).rejects.toThrow("App session unavailable");
    expect(mockCreateAppSession).not.toHaveBeenCalled();
    unmount();
  });

  it("rejects ambiguous catalog pairs before creating a session", async () => {
    const entry = { name: "Timer", slug: "timer", file: "tools/timer/index.html", path: "/files/apps/tools/timer/index.html" };
    mockFetchInstalledApps.mockResolvedValue([entry, entry]);
    const { unmount } = renderHook(() => useComputerAppSession("tools/timer", "timer"));
    await expect(mockUseQuery.mock.calls[1][0].queryFn()).rejects.toThrow("App session unavailable");
    expect(mockCreateAppSession).not.toHaveBeenCalled();
    unmount();
  });

  it("rejects a runtime slug shared by different installed identities", async () => {
    mockFetchInstalledApps.mockResolvedValue([
      { name: "Nested Timer", slug: "timer", file: "tools/timer/index.html", path: "/files/apps/tools/timer/index.html" },
      { name: "Other Timer", slug: "timer", file: "timer/index.html", path: "/files/apps/timer/index.html" },
    ]);
    const { unmount } = renderHook(() => useComputerAppSession("tools/timer", "timer"));
    await expect(mockUseQuery.mock.calls[1][0].queryFn()).rejects.toThrow("App session unavailable");
    expect(mockCreateAppSession).not.toHaveBeenCalled();
    unmount();
  });
});
