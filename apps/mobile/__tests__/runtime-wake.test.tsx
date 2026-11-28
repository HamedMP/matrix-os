import type { ReactNode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";

import { NotificationRouter } from "../components/NotificationRouter";
import { ToastHost } from "../components/ui/Toast";
import { GatewayClient, type RuntimeWakeEvent } from "../lib/gateway-client";
import { NewChatDeliveryUnconfirmedError, recoverNewChatAdmission } from "../lib/queries/new-chat-admission-recovery";
import { useArchiveAgent } from "../lib/queries/use-agents";
import { useBotChat } from "../lib/queries/use-bot-chat";
import { useBotRecipes } from "../lib/queries/use-bot-recipes";
import { useComputerDirectory } from "../lib/queries/use-computer-directory";
import { useComputerIntegrations } from "../lib/queries/use-computer-integrations";
import { useArchiveProject, useCreateProject, useRenameProject } from "../lib/queries/use-project-mutations";
import { dismissToast, showToast, TOAST_DURATION_MS, useToast } from "../lib/toast";
import { fetchAuthenticatedResponse, MAX_RUNTIME_WAKE_HANDLERS, RuntimeWakeTracker, runtimeWakeTracker } from "../lib/requests/http";
import { mobileQueryKeys } from "../lib/requests/query-keys";

const mockOpenTerminal = jest.fn();
const mockShowChatList = jest.fn();
const mockSetGateway = jest.fn();
const mockSelectChat = jest.fn();
const mockNotificationSession = jest.fn();
const mockNotificationComputer = {
  handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice",
};
const mockGetClerkToken = jest.fn();
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: mockGetClerkToken }),
}));
jest.mock("expo-router", () => ({
  useNavigationContainerRef: () => null, useRouter: () => null,
  useSegments: () => ["terminal-session"], useGlobalSearchParams: () => ({}),
}));
jest.mock("@/lib/notification-navigation", () => ({
  openTerminalFromRoot: (...args: unknown[]) => mockOpenTerminal(...args),
  showChatListFromRoot: (...args: unknown[]) => mockShowChatList(...args),
}));
jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ activeChatId: null, selectChat: mockSelectChat, streamLive: true }),
}));
jest.mock("@/lib/queries/use-active-gateway", () => ({
  useActiveGateway: () => ({
    computer: mockNotificationComputer, computerKey: "alice:primary", userId: "user_a",
    isComputerPending: false, session: mockNotificationSession,
  }),
}));
jest.mock("@/lib/requests", () => ({
  ...jest.requireActual("@/lib/requests/query-keys"),
  ...jest.requireActual("@/lib/requests/coding-agent-threads"),
  ...jest.requireActual("@/lib/requests/terminals"),
  ...jest.requireActual("@/lib/requests/files"),
  ...jest.requireActual("@/lib/requests/integrations"),
  ...jest.requireActual("@/lib/requests/projects"),
  ...jest.requireActual("@/lib/requests/bots"),
  fetchChatDetail: jest.requireActual("@/lib/requests/canonical-chat").fetchChatDetail,
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));

function fakeWakeSource() {
  let handler: ((event: RuntimeWakeEvent) => void) | null = null;
  const unsubscribe = jest.fn(() => {
    handler = null;
  });
  return {
    source: {
      subscribe: jest.fn((next: (event: RuntimeWakeEvent) => void) => {
        handler = next;
        return unsubscribe;
      }),
    },
    emit: (event: RuntimeWakeEvent) => act(() => handler?.(event)),
    unsubscribe,
  };
}

describe("ToastHost wake notice", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it("shows the waking state in the shared toast for as long as the computer is waking", () => {
    const { source, emit } = fakeWakeSource();
    render(<ToastHost wakeSource={source} />);
    expect(screen.queryByTestId("toast")).toBeNull();

    emit({ type: "notice", visible: true });
    expect(screen.getByText("Waking your Matrix computer…")).toBeTruthy();
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS * 3));
    expect(screen.getByText("Waking your Matrix computer…")).toBeTruthy();

    emit({ type: "notice", visible: false });
    expect(screen.queryByText("Waking your Matrix computer…")).toBeNull();
  });

  it("says when Matrix is at capacity", () => {
    const { source, emit } = fakeWakeSource();
    render(<ToastHost wakeSource={source} />);

    emit({ type: "failed", code: "runtime_busy" });

    expect(screen.getByText(/Matrix is at capacity/)).toBeTruthy();
  });

  it("reports a burst of parallel failures once", () => {
    const haptic = jest.spyOn(jest.requireActual("../lib/haptics"), "warningHaptic");
    const { source, emit } = fakeWakeSource();
    render(<ToastHost wakeSource={source} />);

    emit({ type: "failed", code: "runtime_waking" });
    emit({ type: "failed", code: "runtime_waking" });
    emit({ type: "failed", code: "runtime_waking" });

    expect(screen.getByText(/still waking up/)).toBeTruthy();
    expect(haptic).toHaveBeenCalledTimes(1);
  });

  it("keeps the waking notice while another request is still waiting after one gives up", () => {
    const tracker = runtimeWakeTracker;
    render(<ToastHost />);
    act(() => {
      tracker.begin();
      tracker.begin();
      jest.advanceTimersByTime(3_000);
    });
    expect(screen.getByText("Waking your Matrix computer…")).toBeTruthy();

    // One request spends its budget; its wait ends and it reports why.
    act(() => {
      tracker.end();
      tracker.fail("runtime_busy");
    });
    expect(screen.getByText(/Matrix is at capacity/)).toBeTruthy();
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS + 100));
    expect(screen.getByText("Waking your Matrix computer…")).toBeTruthy();

    // The last waiting request finishes: now the notice goes.
    act(() => tracker.end());
    expect(screen.queryByText("Waking your Matrix computer…")).toBeNull();
  });

  it("stops listening and takes the notice away when the host unmounts", () => {
    const { source, emit, unsubscribe } = fakeWakeSource();
    const host = render(<ToastHost wakeSource={source} />);
    emit({ type: "notice", visible: true });
    expect(host.getByText("Waking your Matrix computer…")).toBeTruthy();

    host.unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    render(<ToastHost wakeSource={null} />);
    expect(screen.queryByText("Waking your Matrix computer…")).toBeNull();
  });

  it("renders no wake notice without a source", () => {
    const view = render(<ToastHost wakeSource={null} />);
    expect(view.queryByTestId("toast")).toBeNull();
  });
});

// The platform answers an owner request for a sleeping Matrix computer before
// proxying it: 503 + runtimeState + Retry-After (spec 2691, ENG-520).
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const make = (): Response => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(text),
    clone: jest.fn(() => make()),
  }) as unknown as Response;
  return make();
}

const waking = () => response(503, { error: "Matrix computer not ready", runtimeState: "waking" }, { "Retry-After": "3" });
const busy = () => response(503, { error: "Matrix computer not ready", runtimeState: "busy" }, { "Retry-After": "30" });
const unavailable = () => response(503, { error: "Matrix computer unavailable", code: "runtime_unavailable" });
const apps = () => response(200, [{ name: "Notes", path: "notes" }]);

describe("authenticated mutations while the computer wakes", () => {
  const gatewayUrl = "https://app.matrix-os.com/vm/alice";
  const path = "projects";
  const project = { id: "proj_demo", slug: "wake-demo", name: "Wake demo", kind: "scratch" };
  const projectInput = { name: project.name, clientRequestId: "req_wake" };
  const renamedProject = { ...project, name: "Renamed project" };
  const archivedProject = { ...project, archivedAt: "2026-11-27T08:00:00.000Z" };
  const recipe = { recipeId: "inbox-triage", version: "v1" };
  const agentId = "bot_inbox001";
  const chatId = "chat_inbox";
  const agentRequestId = "req_agentwake";
  const interactionId = "in_abcdefgh";
  const grantId = "gr_abcdefgh";
  const answer = { kind: "question" as const, baseRevision: 1, structuredAnswers: { target: ["Acme"] } };
  const resolution = { interaction: { interactionId, status: "resolved", revision: 2 } };
  const modelSelection = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  const memoryId = "mem_abcdefgh";
  const memoryInput = { baseRevision: 3 };
  const memoryResponse = { itemId: memoryId, revision: 4 };
  const createdAgent = { id: agentId, name: "Inbox triage", avatarSeed: "0123456789abcdef", revision: 1, status: "active" };
  const archivedAgent = {
    id: agentId, name: "Inbox triage", revision: 4, archived: true, description: "", instructions: "Triage the inbox",
    selection: { instanceId: "matrix_pi_default", model: "auto" },
    createdAt: "2026-11-27T08:00:00.000Z", updatedAt: "2026-11-27T08:01:00.000Z",
  };
  let client: QueryClient;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const defaults = { retry: false, gcTime: Infinity, staleTime: Infinity };
    client = new QueryClient({ defaultOptions: { queries: defaults, mutations: defaults } });
    client.setQueryData(mobileQueryKeys.activeComputer("user_a"), mockNotificationComputer);
    client.setQueryData(mobileQueryKeys.files("user_a", "alice:primary", path), { path, entries: [] });
    client.setQueryData(mobileQueryKeys.botChat("user_a", gatewayUrl, chatId), {
      agentId, name: createdAgent.name, revision: 3, interactions: [], tasks: [],
      authority: { agentId, revision: 3, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } },
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    ["create file", "POST", "/api/files/touch", { path: "projects/demo.txt" }, { ok: true }, undefined] as const,
    ["create folder", "POST", "/api/files/mkdir", { path: "projects/demo" }, { ok: true }, undefined] as const,
    ["create project", "POST", "/api/projects", projectInput, { project }, project] as const,
    ["rename project", "PATCH", `/api/projects/${project.slug}`, { name: renamedProject.name }, {
      project: renamedProject,
    }, renamedProject] as const,
    ["archive project", "POST", `/api/projects/${project.slug}/actions`, { type: "archive" }, {
      ok: true, action: "archive", project: archivedProject,
    }, archivedProject] as const,
    ["create agent", "POST", "/api/chat-agents/instantiate", { recipe, clientRequestId: agentRequestId }, {
      agent: createdAgent, chatId, operation: "created",
    }, { agentId, chatId }] as const,
    ["archive agent", "PATCH", `/api/chat-agents/${agentId}`, { baseRevision: 3, archived: true },
      archivedAgent, archivedAgent] as const,
    ["answer bot prompt", "POST", `/api/chats/${chatId}/interactions/${interactionId}/resolve?includeRecovery=true`,
      answer, resolution, resolution] as const,
    ["revoke bot grant", "DELETE", `/api/chat-agents/${agentId}/grants/${grantId}`, undefined,
      { grantId, revokedAt: "2026-11-27T08:02:00.000Z" }, undefined] as const,
    ["update bot model", "PATCH", `/api/chat-agents/${agentId}`, { baseRevision: 3, selection: modelSelection },
      { ...archivedAgent, archived: false, selection: modelSelection }, undefined] as const,
    ["forget bot memory", "POST", `/api/chat-agents/${agentId}/memory/${memoryId}/forget`,
      memoryInput, memoryResponse, undefined] as const,
    ["confirm bot memory", "POST", `/api/chat-agents/${agentId}/memory/${memoryId}/confirm`,
      memoryInput, memoryResponse, undefined] as const,
  ])("%s uses a renewed token after a pre-proxy wake refusal", async (action, method, endpoint, body, payload, expectedResult) => {
    let token = "first-token";
    mockGetClerkToken.mockImplementation(async () => token);
    mockNotificationSession.mockResolvedValue({ token, getToken: mockGetClerkToken, gatewayUrl });
    const attempts: Array<{ url: string; method: string; authorization: string; body: unknown }> = [];
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (init?.method !== "POST" && init?.method !== "PATCH" && init?.method !== "DELETE") {
        return response(200, { path, entries: [] });
      }
      const authorization = (init.headers as Record<string, string>).Authorization;
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      attempts.push({ url: String(url), method: init.method, authorization, body });
      if (attempts.length === 1) {
        token = "fresh-token";
        return response(503, { runtimeState: "waking" }, { "Retry-After": "1" });
      }
      return authorization === `Bearer ${token}` ? response(200, payload) : response(401, {});
    });
    const { result } = renderHook(() => {
      const files = useComputerDirectory(path);
      const create = useCreateProject();
      const rename = useRenameProject();
      const archive = useArchiveProject();
      const recipes = useBotRecipes(gatewayUrl, false);
      const archiveAgent = useArchiveAgent();
      const botChat = useBotChat(chatId, gatewayUrl);
      return {
        "create file": () => files.createFile("demo.txt"),
        "create folder": () => files.createFolder("demo"),
        "create project": () => create.mutateAsync(projectInput),
        "rename project": () => rename.mutateAsync({ slug: project.slug, name: renamedProject.name }),
        "archive project": () => archive.mutateAsync(project.slug),
        "create agent": () => recipes.create(recipe, agentRequestId),
        "archive agent": () => archiveAgent.mutateAsync({ agentId, baseRevision: 3 }),
        "answer bot prompt": () => botChat.resolve(interactionId, answer),
        "revoke bot grant": () => botChat.revoke(grantId),
        "update bot model": () => botChat.updateModel(modelSelection),
        "forget bot memory": () => botChat.memory(memoryId, "forget", memoryInput),
        "confirm bot memory": () => botChat.memory(memoryId, "confirm", memoryInput),
      };
    }, {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await act(async () => {
      const mutation = expect(result.current[action]()).resolves.toEqual(expectedResult);
      await Promise.all([mutation, jest.advanceTimersByTimeAsync(1_200)]);
    });
    expect(attempts).toEqual(["first-token", "fresh-token"].map((bearer) => ({
      url: `${gatewayUrl}${endpoint}`, method, authorization: `Bearer ${bearer}`, body,
    })));
  });
});

describe("Integration changes while the computer wakes", () => {
  const connectionId = "11111111-1111-1111-1111-111111111111";
  const link = "https://pipedream.com/connect/demo";
  const gatewayUrl = "https://app.matrix-os.com/vm/alice";
  const successfulRefresh = { id: connectionId, service: "demo", status: "active" };

  it.each([
    ["refresh", "POST", `/api/integrations/${connectionId}/refresh`, successfulRefresh, undefined],
    ["disconnect", "DELETE", `/api/integrations/${connectionId}`, { ok: true }, undefined],
    ["connect", "POST", "/api/integrations/connect", { url: link, service: "demo" }, link],
    ["sync", "POST", "/api/integrations/sync", { synced: 0, services: [] }, undefined],
  ] as const)("%s uses a renewed token after wake", async (operation, method, endpoint, payload, resultValue) => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const defaults = { retry: false, gcTime: Infinity, staleTime: Infinity };
    const client = new QueryClient({ defaultOptions: { queries: defaults, mutations: defaults } });
    client.setQueryData(mobileQueryKeys.activeComputer("user_a"), mockNotificationComputer);
    client.setQueryData(mobileQueryKeys.integrations("user_a", "alice:primary"), { available: [], connected: [] });
    let token = "expiring";
    mockGetClerkToken.mockImplementation(async () => token);
    const authorization: Array<string | null> = [];
    const transport = jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (init?.method !== method || String(url) !== gatewayUrl + endpoint) return response(200, []);
      const bearer = new Headers(init.headers).get("authorization");
      authorization.push(bearer);
      if (authorization.length === 1) {
        token = "renewed";
        return response(503, { runtimeState: "waking" }, { "Retry-After": "1" });
      }
      return bearer === "Bearer renewed" ? response(200, payload) : response(401, {});
    });
    const { result, unmount } = renderHook(useComputerIntegrations, {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    try {
      const invoke = {
        refresh: () => result.current.refreshConnection(connectionId),
        disconnect: () => result.current.deleteConnection(connectionId),
        connect: () => result.current.startConnection("demo"),
        sync: () => result.current.syncConnections(),
      };
      await act(async () => {
        await Promise.all([expect(invoke[operation]()).resolves.toBe(resultValue), jest.advanceTimersByTimeAsync(1_100)]);
      });
      expect(authorization).toEqual(["Bearer expiring", "Bearer renewed"]);
      const writes = transport.mock.calls.filter(([url, init]) => String(url) === gatewayUrl + endpoint && init?.method === method);
      expect(writes[0]?.[1]?.body).toBe(writes[1]?.[1]?.body);
    } finally {
      unmount();
      client.clear();
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });
});

describe("opening a terminal notification while the computer wakes", () => {
  const notifications = Notifications as jest.Mocked<typeof Notifications>;
  const gatewayUrl = "https://app.matrix-os.com/vm/alice";
  const threadId = "thread_mobile_attention";
  const terminalRef = {
    workspaceId: "tws_00000000000000000000000000000001",
    tabId: "tt_00000000000000000000000000000001",
  };
  const threadUrl = `${gatewayUrl}/api/coding-agents/threads/${threadId}`;
  const listUrl = `${gatewayUrl}/api/terminal/workspaces`;
  const authorization = (bearer: string) => expect.objectContaining({
    headers: expect.objectContaining({ Authorization: `Bearer ${bearer}` }),
  });
  let client: QueryClient;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    // Use the test clock for AbortSignal.timeout while preserving abort behavior.
    jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    client = new QueryClient();
    client.setQueryData(mobileQueryKeys.activeComputer("user_a"), mockNotificationComputer);
    notifications.getLastNotificationResponse.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    client.clear();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    { problem: "the platform's full wake wait", delayMs: 10_200, renewed: "first-token" },
    { problem: "expiry of the first bearer", delayMs: 0, renewed: "fresh-token" },
  ])("opens the linked terminal after $problem", async ({ delayMs, renewed }) => {
    let token = "first-token";
    const getToken = jest.fn(async () => token);
    mockNotificationSession.mockResolvedValue({ token, getToken, gatewayUrl });
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      if (delayMs) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        }, { once: true });
      });
      token = renewed;
      return response(503, { runtimeState: "waking" }, { "Retry-After": "1" });
    }).mockImplementation(async (url, init) => {
      if ((init?.headers as Record<string, string>).Authorization !== `Bearer ${token}`) return response(401, {});
      if (url === threadUrl) return response(200, { thread: { terminalRef } });
      return response(200, { workspaces: [{
        id: terminalRef.workspaceId,
        tabs: [{ id: terminalRef.tabId, name: "Linked terminal", status: "idle", revision: 1 }],
      }] });
    });
    render(
      <QueryClientProvider client={client}>
        <NotificationRouter connected setGateway={mockSetGateway} />
      </QueryClientProvider>,
    );
    const tap = notifications.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];
    act(() => tap({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: {
        date: Date.now(),
        request: {
          identifier: "terminal-tap",
          trigger: null,
          content: {
            title: null, subtitle: null, body: null, categoryIdentifier: null, sound: null, threadIdentifier: null,
            data: { category: "agent", threadId },
          },
        },
      },
    }));

    await act(async () => jest.advanceTimersByTimeAsync(delayMs + 1_200));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(1, threadUrl, authorization("first-token"));
    expect(fetchMock).toHaveBeenNthCalledWith(2, threadUrl, authorization(renewed));
    expect(fetchMock).toHaveBeenNthCalledWith(3, listUrl, authorization(renewed));
    expect(mockOpenTerminal).toHaveBeenCalledWith(null, null, `${terminalRef.workspaceId}:${terminalRef.tabId}`);
    expect(mockShowChatList).not.toHaveBeenCalled();
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });
});

describe("GatewayClient waits for a waking Matrix computer", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retries a 503 with runtimeState waking after Retry-After, up to 30 s total", async () => {
    const calledAt: number[] = [];
    fetchMock.mockImplementation(async () => {
      calledAt.push(Date.now());
      return waking();
    });
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));
    const startedAt = Date.now();

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(calledAt.at(-1)! - startedAt).toBeLessThanOrEqual(30_000);
    expect(events.at(-1)).toEqual({ type: "failed", code: "runtime_waking" });
  });

  it("returns the real response once the computer is awake", async () => {
    fetchMock
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(apps());
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toEqual([{ name: "Notes", path: "notes" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBeDefined();
    }
  });

  it.each([
    ["gateway apps", () => new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token").getApps()],
    ["authenticated Chat", () => fetchAuthenticatedResponse({
      url: "https://app.matrix-os.com/vm/alice/api/chats",
      token: "clerk-token",
      errorMessage: "Chat unavailable",
      method: "POST",
      body: "{}",
    }, (res) => res.json())],
  ] as const)("%s can receive a wake refusal after the platform's 10-second wait", async (_name, request) => {
    // Jest's fake clock does not advance Node's native AbortSignal.timeout.
    jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(waking()), 10_200);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Request timed out"));
      }, { once: true });
    })).mockResolvedValueOnce(apps());

    const result = request().catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(13_200);

    expect(await result).toEqual([{ name: "Notes", path: "notes" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 503 runtime_unavailable more than once", async () => {
    fetchMock.mockImplementation(async () => unavailable());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: "failed", code: "runtime_unavailable" });
  });

  it("retries a busy computer once after at most 10 s, then reports capacity", async () => {
    fetchMock.mockImplementation(async () => busy());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: "failed", code: "runtime_busy" });
  });

  it("shows the waking state after 3 s", async () => {
    fetchMock
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(apps());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(client.isWakeNoticeVisible).toBe(false);
    expect(events).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    expect(client.isWakeNoticeVisible).toBe(true);
    expect(events).toEqual([{ type: "notice", visible: true }]);

    await jest.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toHaveLength(1);
    expect(client.isWakeNoticeVisible).toBe(false);
    expect(events).toEqual([
      { type: "notice", visible: true },
      { type: "notice", visible: false },
    ]);
  });

  it("never shows the notice for a wake that finishes within 3 s", async () => {
    const quickWake = response(503, { runtimeState: "starting" }, { "Retry-After": "2" });
    fetchMock.mockResolvedValueOnce(quickWake).mockResolvedValueOnce(apps());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toHaveLength(1);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(events).toEqual([]);
  });

  it("stops waiting when the caller aborts", async () => {
    fetchMock.mockImplementation(async () => waking());
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    const controller = new AbortController();

    const result = client.getGithubDeveloperSetup("4f8e2c1a-9b7d-4e3f-8a6b-2c1d0e9f8a7b", controller.signal)
      .catch((err: unknown) => err);
    await jest.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(await result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.isWakeNoticeVisible).toBe(false);
  });

  it("waits for the computer before a terminal reconnect opens its websocket", async () => {
    fetchMock
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(response(200, { status: "ok" }));
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");

    const ready = client.waitForRuntimeAwake();
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(ready).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.matrix-os.com/vm/alice/health");
  });
});

describe("runtime wake review fixes", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("bounds lost Chat admission recovery to five two-second reads during wake", async () => {
    jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    fetchMock.mockImplementation(async () => waking());
    const failed = jest.fn();
    void recoverNewChatAdmission({
      gatewayUrl: "https://app.matrix-os.com/vm/alice",
      chatId: "chat_new",
      turnRequestId: "request_original",
      getToken: async () => "clerk-token",
    }).catch(failed);
    await jest.advanceTimersByTimeAsync(13_999);
    expect(failed).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledWith(new NewChatDeliveryUnconfirmedError());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.every(([, init]) => !init.method || init.method === "GET")).toBe(true);
  });

  it("Chat requests wait for a waking computer and show the shared notice", async () => {
    fetchMock
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(response(200, { ok: true }));
    const events: unknown[] = [];
    const unsubscribe = runtimeWakeTracker.subscribe((event) => events.push(event));
    try {
      const result = fetchAuthenticatedResponse(
        { url: "https://app.matrix-os.com/vm/alice/api/chats", token: "clerk-token", errorMessage: "Chat unavailable", method: "POST", body: "{}" },
        async (res) => res.json(),
      );
      await jest.advanceTimersByTimeAsync(6_000);
      await expect(result).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(events).toEqual([{ type: "notice", visible: true }, { type: "notice", visible: false }]);
    } finally {
      unsubscribe();
    }
  });

  it("a closed terminal stops its wake probe", async () => {
    fetchMock.mockImplementation(async () => waking());
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    const controller = new AbortController();
    const ready = client.waitForRuntimeAwake(controller.signal);
    await jest.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await expect(ready).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.isWakeNoticeVisible).toBe(false);
  });

  it("tells a new subscriber that a wake notice is already showing", () => {
    const tracker = new RuntimeWakeTracker();
    tracker.begin();
    jest.advanceTimersByTime(3_000);
    expect(tracker.isNoticeVisible).toBe(true);
    const late = jest.fn();
    tracker.subscribe(late);
    expect(late).toHaveBeenCalledWith({ type: "notice", visible: true });
    tracker.end();
    expect(late).toHaveBeenLastCalledWith({ type: "notice", visible: false });

    const idle = jest.fn();
    tracker.subscribe(idle);
    expect(idle).not.toHaveBeenCalled();
  });

  it("caps wake subscriptions and evicts the oldest", () => {
    const tracker = new RuntimeWakeTracker();
    const handlers = Array.from({ length: MAX_RUNTIME_WAKE_HANDLERS + 1 }, () => jest.fn());
    for (const handler of handlers) tracker.subscribe(handler);
    tracker.fail("runtime_busy");
    expect(handlers[0]).not.toHaveBeenCalled();
    expect(handlers.at(-1)).toHaveBeenCalledTimes(1);
  });
});

describe("toast progress", () => {
  it("brings a persistent progress toast back once a temporary toast ends", () => {
    jest.useFakeTimers();
    let current: ReturnType<typeof useToast> = null;
    // Drive the store directly through its subscription, like a mounted host.
    const hook = renderHook(() => useToast());
    const progress = showToast("Waking your Matrix computer…", "progress", { persistent: true });
    showToast("Copied", "success");
    hook.rerender({});
    expect(hook.result.current?.message).toBe("Copied");
    jest.advanceTimersByTime(5_000);
    hook.rerender({});
    current = hook.result.current;
    expect(current?.message).toBe("Waking your Matrix computer…");
    dismissToast(progress!);
    hook.rerender({});
    expect(hook.result.current).toBeNull();
    hook.unmount();
    jest.useRealTimers();
  });
});
