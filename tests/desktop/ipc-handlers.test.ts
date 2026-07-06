import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerIpcHandlers, type HandlerContext } from "../../desktop/src/main/ipc/handlers";

type IpcListener = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

function makeHarness(overrides: Partial<HandlerContext> = {}) {
  const listeners = new Map<string, IpcListener>();
  const ipcMain = {
    handle: vi.fn((channel: string, listener: IpcListener) => {
      listeners.set(channel, listener);
    }),
  };
  const ctx = {
    auth: {
      startDeviceFlow: vi.fn(),
      poll: vi.fn(),
      getStatus: vi.fn(),
      signOut: vi.fn(),
      expireSession: vi.fn(),
      selectRuntime: vi.fn(),
    },
    store: {
      get: vi.fn(),
      setUnknown: vi.fn(),
      setPanelLayout: vi.fn(),
    },
    embeds: {
      open: vi.fn(),
      setBounds: vi.fn(),
      setActive: vi.fn(),
      close: vi.fn(),
      retryAuth: vi.fn(),
    },
    openExternal: vi.fn(),
    setBadgeCount: vi.fn(),
    notify: vi.fn(),
    onRuntimeChanged: vi.fn(),
    getUpdateStatus: vi.fn(() => "disabled"),
    fetchRuntimeSummary: vi.fn(),
    createAgentThread: vi.fn(),
    ...overrides,
  } as unknown as HandlerContext;

  registerIpcHandlers(ipcMain, ctx);

  return {
    ctx,
    invoke(channel: string, payload: unknown = {}) {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`missing listener: ${channel}`);
      return listener({}, payload);
    },
  };
}

describe("registerIpcHandlers", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns a generic error when handler implementations throw raw errors", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ctx.auth.signOut).mockRejectedValue(
      new Error("EACCES: permission denied, unlink '/home/user/.matrix/credential.json'"),
    );

    await expect(harness.invoke("auth:sign-out")).rejects.toThrow("internal error");
    await expect(harness.invoke("auth:sign-out")).rejects.not.toThrow("/home/user");
    expect(console.warn).toHaveBeenCalledWith(
      "[ipc] handler for auth:sign-out failed:",
      "EACCES: permission denied, unlink '/home/user/.matrix/credential.json'",
    );
  });

  it("keeps malformed requests generic", async () => {
    const harness = makeHarness();

    await expect(harness.invoke("shell:open-external", { url: "file:///tmp/secret" })).rejects.toThrow(
      "invalid request",
    );
  });

  it("returns the public embed unavailable error when embed open fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ctx.embeds.open).mockRejectedValue(new Error("native view unavailable"));

    await expect(
      harness.invoke("embed:open", {
        kind: "app",
        slug: "workspace",
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      }),
    ).rejects.toThrow("embed unavailable");
  });

  it("returns a failed retry-auth result when embed retry throws", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ctx.embeds.retryAuth).mockRejectedValue(new Error("handoff unavailable"));

    await expect(harness.invoke("embed:retry-auth", { embedId: "embed-1" })).resolves.toEqual({
      ok: false,
    });
    expect(console.warn).toHaveBeenCalledWith("[ipc] embed:retry-auth failed:", "handoff unavailable");
  });

  it("reports the live updater status from the handler context", async () => {
    const harness = makeHarness({ getUpdateStatus: vi.fn(() => "ready") });

    await expect(harness.invoke("update:check")).resolves.toEqual({ status: "ready" });
  });

  it("returns the runtime summary through a strict trusted-core IPC channel", async () => {
    const summary = {
      runtime: {
        id: "rt_primary",
        label: "Primary",
        status: "available",
      },
      capabilities: [
        {
          id: "codingAgentsRuntimeSummary",
          enabled: true,
        },
      ],
      providers: [],
      projects: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      activeThreads: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      terminalSessions: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      recentActivity: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      limits: {
        maxPromptBytes: 16384,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 8192,
        maxListItems: 20,
      },
      serverTime: "2026-07-06T00:00:00.000Z",
    };
    const fetchRuntimeSummary = vi.fn().mockResolvedValue(summary);
    const harness = makeHarness({ fetchRuntimeSummary } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-summary")).resolves.toEqual(summary);
    expect(fetchRuntimeSummary).toHaveBeenCalledWith();
  });

  it("maps runtime summary failures to a generic IPC error", async () => {
    const fetchRuntimeSummary = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:4000"));
    const harness = makeHarness({ fetchRuntimeSummary } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-summary")).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:get-summary")).rejects.not.toThrow("10.0.0.5");
  });

  it("creates agent threads through trusted-core IPC without exposing credentials", async () => {
    const snapshot = {
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Summarize the failing checks",
        status: "queued",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:00.000Z",
      },
      events: {
        items: [],
        hasMore: false,
        limit: 200,
      },
    };
    const createAgentThread = vi.fn().mockResolvedValue(snapshot);
    const harness = makeHarness({ createAgentThread } as Partial<HandlerContext>);
    const request = {
      providerId: "codex",
      prompt: "Summarize the failing checks",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      clientRequestId: "req_desktop_1",
    };

    await expect(harness.invoke("runtime:create-thread", request)).resolves.toEqual(snapshot);
    expect(createAgentThread).toHaveBeenCalledWith(request);
  });

  it("maps agent thread create failures to a generic IPC error", async () => {
    const createAgentThread = vi
      .fn()
      .mockRejectedValue(new Error("provider failed on /home/matrix/workspace with token secret"));
    const harness = makeHarness({ createAgentThread } as Partial<HandlerContext>);

    await expect(
      harness.invoke("runtime:create-thread", {
        providerId: "codex",
        prompt: "Summarize the failing checks",
        clientRequestId: "req_desktop_1",
      }),
    ).rejects.toThrow("internal error");
    await expect(
      harness.invoke("runtime:create-thread", {
        providerId: "codex",
        prompt: "Summarize the failing checks",
        clientRequestId: "req_desktop_1",
      }),
    ).rejects.not.toThrow("/home/matrix");
  });
});
