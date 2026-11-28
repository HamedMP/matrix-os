import { ReadableStream } from "node:stream/web";
import { TextDecoder } from "node:util";
import { fetch as expoFetch } from "expo/fetch";
import { createMobileAppCapabilityBroker } from "../lib/app-capability-bridge";
import type { RequestToken } from "../lib/requests/http";

const mockGetToken = jest.fn(async () => "owner-token");
const mockUseQuery = jest.fn();
const mockCreateAppSession = jest.fn(async (_token: RequestToken, _gateway: string, _slug: string) => ({ launchUrl: "/apps/chess/?session=fixture" }));
const mockFetchInstalledApps = jest.fn();

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: mockGetToken, isLoaded: true, isSignedIn: true, userId: "owner" }),
}));
jest.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => mockUseQuery(options) }));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("@/lib/requests", () => ({
  createAppSession: (...args: [RequestToken, string, string]) => mockCreateAppSession(...args),
  fetchActiveComputer: jest.fn(), fetchInstalledApps: (...args: [RequestToken, string]) => mockFetchInstalledApps(...args),
  mobileQueryKeys: {
    activeComputer: (owner: string) => ["computer", owner],
    apps: (owner: string, computer: string) => ["apps", owner, computer],
    appSession: (owner: string, computer: string, app: string) => ["session", owner, computer, app],
  },
}));
jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
  resolveMobileAppSessionLaunchUrl: (gateway: string, path: string) => gateway + path,
}));

import { act, renderHook } from "@testing-library/react-native";
import { installedAppSlug, useComputerApps, useComputerAppSession } from "../lib/queries/use-computer-apps";

import { createAppSession, fetchInstalledApps } from "../lib/requests/apps";

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
    expect(mockCreateAppSession).toHaveBeenCalledWith(mockGetToken, "https://app.matrix-os.com/vm/fixture", "chess");
    unmount();
  });

  it.each([
    { flow: "installed-app list", route: "/api/apps", launch: false },
    { flow: "app catalog during launch", route: "/api/apps", launch: true },
    { flow: "app session creation", route: "/api/apps/chess/session-token", launch: true },
  ])("renews the bearer on a waking $flow request", async ({ route, launch }) => {
    jest.useFakeTimers();
    const random = jest.spyOn(Math, "random").mockReturnValue(0);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const startedAt = Date.now();
    mockGetToken.mockImplementation(async () => Date.now() - startedAt < 500 ? "expiring" : "renewed");
    mockUseQuery.mockReturnValue({});
    const apps = [{ name: "Chess", slug: "chess", file: "games/chess/index.html", path: "/files/apps/games/chess/index.html" }];
    const session = { launchUrl: "/apps/chess/?session=fixture", expiresAt: 1_800_000_000_000 };
    const bearerAttempts: string[] = [];
    mockFetchInstalledApps.mockImplementationOnce(fetchInstalledApps);
    if (launch) mockCreateAppSession.mockImplementationOnce(createAppSession);
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname.replace("/vm/fixture", "");
      const bearer = (init?.headers as Record<string, string>).Authorization;
      if (path === route) {
        bearerAttempts.push(bearer);
        if (bearerAttempts.length === 1) return {
          status: 503,
          headers: { get: (name: string) => name === "retry-after" ? "1" : null },
          clone: () => ({ text: async () => '{"runtimeState":"waking"}' }),
        } as unknown as Response;
      }
      const currentBearer = Date.now() - startedAt < 500 ? "Bearer expiring" : "Bearer renewed";
      if (bearer !== currentBearer) return { status: 401, ok: false } as Response;
      return { status: 200, ok: true, json: async () => path === "/api/apps" ? apps : session } as Response;
    });

    const useFlow: () => unknown = launch ? () => useComputerAppSession("games/chess") : useComputerApps;
    const { unmount } = renderHook(useFlow);
    try {
      const pending = mockUseQuery.mock.calls[1][0].queryFn().catch((error: unknown) => error);
      await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });

      expect(await pending).toEqual(launch ? { ...session, appIdentity: "games/chess", runtimeSlug: "chess" } : apps);
      expect(bearerAttempts).toEqual(["Bearer expiring", "Bearer renewed"]);
    } finally {
      unmount();
      fetchMock.mockRestore();
      mockGetToken.mockImplementation(async () => "owner-token");
      random.mockRestore();
      warn.mockRestore();
      jest.useRealTimers();
    }
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
    expect(mockFetchInstalledApps).toHaveBeenCalledWith(mockGetToken, "https://app.matrix-os.com/vm/fixture");
    expect(mockCreateAppSession).toHaveBeenCalledWith(mockGetToken, "https://app.matrix-os.com/vm/fixture", "timer");
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

describe("requests from an open app", () => {
  const platform = jest.mocked(expoFetch);
  const launch = { launchId: "launch", documentId: "doc" };
  const runtimeUrl = "https://app.matrix-os.com/vm/fixture/apps/notes/?session=fixture";
  const save = { kind: "db", input: { action: "insert", table: "notes", data: { text: "first save" } } };
  const savedNote = { id: 1, text: "first save" };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    platform.mockReset();
    mockUseQuery.mockReset();
    mockUseQuery.mockReturnValueOnce({ data: { handle: "fixture", runtimeSlot: "live", gatewayPath: "/vm/fixture" } })
      .mockReturnValueOnce({ data: { launchUrl: "/apps/notes/?session=fixture" } });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function openApp() {
    const { result, unmount } = renderHook(() => useComputerAppSession("notes"));
    const reply = jest.fn();
    const broker = createMobileAppCapabilityBroker({
      app: "notes", runtimeUrl, launchId: launch.launchId, request: result.current.requestAppBridge, reply,
    });
    await broker.receive(JSON.stringify({ type: "matrix:app-ready", ...launch }), runtimeUrl);
    return {
      reply,
      request: (message: { kind: string; input: object } = save) =>
        broker.receive(JSON.stringify({ type: "matrix:app-request", ...launch, id: 1, ...message }), runtimeUrl),
      close: () => { broker.dispose(); unmount(); },
    };
  }

  function refusal(body: object, seconds = "3") {
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: { "Retry-After": seconds, "Content-Type": "application/json" },
    }) as unknown as Awaited<ReturnType<typeof expoFetch>>;
  }

  it("saves once after a confirmed wake refusal, using a renewed bearer and the same payload", async () => {
    const decoder = Object.getOwnPropertyDescriptor(globalThis, "TextDecoder");
    Object.defineProperty(globalThis, "TextDecoder", { configurable: true, value: TextDecoder });
    mockGetToken.mockResolvedValueOnce("expiring").mockResolvedValueOnce("renewed");
    const applied = jest.fn();
    platform.mockResolvedValueOnce(refusal({ runtimeState: "waking" }))
      .mockImplementationOnce(async () => {
        applied();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from(JSON.stringify(savedNote)));
            controller.close();
          },
        });
        return { ok: true, status: 200, headers: new Headers(), body } as unknown as Awaited<ReturnType<typeof expoFetch>>;
      });
    const app = await openApp();
    try {
      const pending = app.request();
      await jest.advanceTimersByTimeAsync(2_999);
      expect(platform).toHaveBeenCalledTimes(1);
      expect(app.reply).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(platform).toHaveBeenCalledTimes(2);
      for (const [index, bearer] of ["expiring", "renewed"].entries()) {
        expect(platform).toHaveBeenNthCalledWith(index + 1, "https://app.matrix-os.com/vm/fixture/api/bridge/query", expect.objectContaining({
          method: "POST", body: JSON.stringify({ ...save.input, app: "notes" }),
          headers: expect.objectContaining({ Authorization: `Bearer ${bearer}` }),
          signal: expect.anything(), redirect: "error",
        }));
      }
      expect(applied).toHaveBeenCalledTimes(1);
      expect(app.reply).toHaveBeenCalledTimes(1);
      expect(app.reply.mock.calls[0][0]).toContain('"ok":true,"body":{"id":1,"text":"first save"}');
    } finally {
      app.close();
      if (decoder) Object.defineProperty(globalThis, "TextDecoder", decoder);
      else Reflect.deleteProperty(globalThis, "TextDecoder");
    }
  });

  it.each([
    { operation: "save", request: save, body: { error: "unavailable" } },
    { operation: "save", request: save, body: { code: "runtime_unavailable" } },
    { operation: "AI route lookup", request: { kind: "ai.routes", input: {} }, body: { code: "runtime_unavailable" } },
  ])("returns a $operation error after one attempt for an ambiguous 503 ($body)", async ({ request, body }) => {
    platform.mockResolvedValueOnce(refusal(body));
    const app = await openApp();
    try {
      const pending = app.request(request);
      await jest.advanceTimersByTimeAsync(3_000);
      await pending;
      expect(platform).toHaveBeenCalledTimes(1);
      expect(app.reply).toHaveBeenCalledWith(expect.stringContaining('"ok":false'));
    } finally {
      app.close();
    }
  });

  it("aborts an in-flight save retry at the original deadline", async () => {
    let retrySignal: AbortSignal | undefined;
    platform.mockResolvedValueOnce(refusal({ runtimeState: "waking" }))
      .mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
        retrySignal = init?.signal ?? undefined;
        retrySignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const app = await openApp();
    try {
      const pending = app.request();
      await jest.advanceTimersByTimeAsync(34_999);
      expect(retrySignal?.aborted).toBe(false);
      expect(app.reply).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(retrySignal?.aborted).toBe(true);
      expect(platform).toHaveBeenCalledTimes(2);
      expect(app.reply).toHaveBeenCalledWith(expect.stringContaining('"ok":false'));
    } finally {
      app.close();
    }
  });
});
