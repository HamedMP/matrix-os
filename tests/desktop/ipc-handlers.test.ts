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
});
