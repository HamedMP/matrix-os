import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebContentsView } from "@desktop/main/embeds/web-contents-view";

const electronMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const handlers = new Map<string, Handler>();
  const viewOptions: unknown[] = [];
  const webContents = {
    id: 42,
    session: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    },
    on: vi.fn((eventName: string, handler: Handler) => {
      handlers.set(eventName, handler);
      return webContents;
    }),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async () => {}),
    capturePage: vi.fn(async () => ({
      isEmpty: () => false,
      toJPEG: () => Buffer.from("retained-frame"),
    })),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
  };
  class WebContentsView {
    webContents = webContents;
    setBounds = vi.fn();
    constructor(options: unknown) {
      viewOptions.push(options);
    }
  }
  return {
    handlers,
    viewOptions,
    webContents,
    shell: { openExternal: vi.fn() },
    WebContentsView,
  };
});

vi.mock("electron", () => electronMock);

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.viewOptions.length = 0;
  electronMock.shell.openExternal.mockClear();
  electronMock.webContents.setWindowOpenHandler.mockClear();
  electronMock.webContents.loadURL.mockClear();
  electronMock.webContents.capturePage.mockClear();
  electronMock.webContents.isDestroyed.mockReset();
  electronMock.webContents.isDestroyed.mockReturnValue(false);
  electronMock.webContents.close.mockClear();
  electronMock.webContents.session.setPermissionCheckHandler.mockClear();
  electronMock.webContents.session.setPermissionRequestHandler.mockClear();
});

describe("createWebContentsView", () => {
  it("captures a bounded JPEG frame for the detached renderer fallback", async () => {
    const view = createWebContentsView({
      window: {
        isDestroyed: () => false,
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:browser",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });

    await expect(view.captureSnapshot?.()).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from("retained-frame").toString("base64")}`,
    );
  });

  it("deduplicates overlapping retained-frame captures", async () => {
    let resolveCapture: ((image: {
      isEmpty: () => boolean;
      toJPEG: () => Buffer;
    }) => void) | null = null;
    electronMock.webContents.capturePage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCapture = resolve;
    }));
    const view = createWebContentsView({
      window: {
        isDestroyed: () => false,
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:browser",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });

    const first = view.captureSnapshot?.();
    const second = view.captureSnapshot?.();
    expect(electronMock.webContents.capturePage).toHaveBeenCalledOnce();
    resolveCapture?.({
      isEmpty: () => false,
      toJPEG: () => Buffer.from("shared-frame"),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      `data:image/jpeg;base64,${Buffer.from("shared-frame").toString("base64")}`,
      `data:image/jpeg;base64,${Buffer.from("shared-frame").toString("base64")}`,
    ]);
  });

  it("caps the native capture rectangle before allocating a retained frame", async () => {
    const view = createWebContentsView({
      window: {
        isDestroyed: () => false,
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:browser",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });
    view.setBounds({ x: 20, y: 30, width: 16_384, height: 8_192 });

    await view.captureSnapshot?.();

    expect(electronMock.webContents.capturePage).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 2_048,
      height: 2_048,
    });
  });

  it("does not retain a capture that finishes after a new page starts loading", async () => {
    let resolveCapture: ((image: {
      isEmpty: () => boolean;
      toJPEG: () => Buffer;
    }) => void) | null = null;
    electronMock.webContents.capturePage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCapture = resolve;
    }));
    const view = createWebContentsView({
      window: {
        isDestroyed: () => false,
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:browser",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });

    const staleCapture = view.captureSnapshot?.();
    electronMock.handlers.get("did-start-loading")?.();
    resolveCapture?.({
      isEmpty: () => false,
      toJPEG: () => Buffer.from("stale-frame"),
    });

    await expect(staleCapture).resolves.toBeNull();
  });

  it("downscales an oversized frame instead of dropping the retained content", async () => {
    const resized = {
      isEmpty: () => false,
      toJPEG: () => Buffer.from("bounded-frame"),
      getSize: () => ({ width: 1344, height: 840 }),
      resize: vi.fn(),
    };
    electronMock.webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      toJPEG: () => Buffer.alloc(3_000_001),
      getSize: () => ({ width: 1920, height: 1200 }),
      resize: vi.fn(() => resized),
    });
    const view = createWebContentsView({
      window: {
        isDestroyed: () => false,
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:browser",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });

    await expect(view.captureSnapshot?.()).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from("bounded-frame").toString("base64")}`,
    );
  });

  it("falls back to the warmed frame when a later native capture is empty", async () => {
    const view = createWebContentsView({
      window: {
        isDestroyed: () => false,
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:browser",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });
    electronMock.handlers.get("did-finish-load")?.();
    await vi.waitFor(() => expect(electronMock.webContents.capturePage).toHaveBeenCalledOnce());
    electronMock.webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => true,
      toJPEG: vi.fn(),
    });

    await expect(view.captureSnapshot?.()).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from("retained-frame").toString("base64")}`,
    );
  });

  it("detaches safely after the parent window has already been destroyed", () => {
    let windowDestroyed = false;
    const removeChildView = vi.fn(() => {
      if (windowDestroyed) throw new TypeError("Object has been destroyed");
    });
    const view = createWebContentsView({
      window: {
        isDestroyed: () => windowDestroyed,
        contentView: { addChildView: vi.fn(), removeChildView },
      } as never,
      partition: "persist:hosted-shell",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });

    view.attach();
    windowDestroyed = true;

    expect(() => view.detach()).not.toThrow();
    expect(() => view.destroy()).not.toThrow();
    expect(removeChildView).not.toHaveBeenCalled();
    expect(electronMock.webContents.close).toHaveBeenCalledOnce();
  });

  it("denies browser permissions for the trusted code editor surface", () => {
    createWebContentsView({
      window: {
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:code-editor",
      allowedOrigins: ["https://code.matrix-os.com"],
      denyPermissions: true,
      onState: vi.fn(),
    });

    expect(electronMock.webContents.session.setPermissionCheckHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(electronMock.webContents.session.setPermissionRequestHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });

  it("installs the restricted bridge preload only for app views and unregisters it on close", () => {
    const register = vi.fn();
    const unregister = vi.fn();
    createWebContentsView({
      window: {
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:app-notes",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
      appBridge: {
        appIdentity: "notes",
        routeSlug: "notes",
        preloadPath: "/app/preload/app-bridge.cjs",
        register,
        unregister,
      },
    });

    expect(electronMock.viewOptions[0]).toEqual(expect.objectContaining({
      webPreferences: expect.objectContaining({
        preload: "/app/preload/app-bridge.cjs",
        additionalArguments: ["--matrix-app-bridge"],
      }),
    }));
    expect(register).toHaveBeenCalledWith(42, "notes", "notes");
    expect(electronMock.webContents.session.setPermissionCheckHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(electronMock.webContents.session.setPermissionRequestHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
    const permissionCheck = electronMock.webContents.session.setPermissionCheckHandler.mock.calls[0]?.[0];
    const permissionRequest = electronMock.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0];
    const permissionCallback = vi.fn();
    expect(permissionCheck?.()).toBe(false);
    permissionRequest?.(electronMock.webContents, "media", permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
    const view = createWebContentsView({
      window: {
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:hosted-shell",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });
    view.destroy();
    expect(unregister).not.toHaveBeenCalled();

    const bridgedView = createWebContentsView({
      window: {
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:app-notes",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
      appBridge: {
        appIdentity: "notes",
        routeSlug: "notes",
        preloadPath: "/app/preload/app-bridge.cjs",
        register,
        unregister,
      },
    });
    bridgedView.destroy();
    expect(unregister).toHaveBeenCalledWith(42);
  });
  it("blocks external server-side redirects", () => {
    createWebContentsView({
      window: {
        contentView: {
          addChildView: vi.fn(),
          removeChildView: vi.fn(),
        },
      } as never,
      partition: "persist:app-notes",
      allowedOrigins: ["https://gateway.test"],
      onState: vi.fn(),
    });
    const preventDefault = vi.fn();

    const redirectCall = electronMock.webContents.on.mock.calls.find(
      ([eventName]) => eventName === "will-redirect",
    );
    expect(redirectCall).toBeTruthy();
    redirectCall?.[1]({ preventDefault }, "https://evil.test/phish");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith("https://evil.test/phish");
  });

  it("rewrites canonical runtime redirects and popups through the authenticated tunnel", () => {
    const resolveNavigation = vi.fn(() => ({
      disposition: "rewrite" as const,
      url: "http://127.0.0.1:49152/callback?code=ok",
    }));
    createWebContentsView({
      window: {
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "runtime-browser-id",
      allowedOrigins: ["http://127.0.0.1:49152"],
      resolveNavigation,
      onState: vi.fn(),
    });
    const preventDefault = vi.fn();
    const redirect = electronMock.handlers.get("will-redirect");

    redirect?.({ preventDefault }, "http://localhost:3000/callback?code=ok");
    const openHandler = electronMock.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler?.({ url: "http://localhost:3000/callback?code=ok" })).toEqual({ action: "deny" });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(resolveNavigation).toHaveBeenCalledWith("http://localhost:3000/callback?code=ok");
    expect(electronMock.webContents.loadURL).toHaveBeenCalledTimes(2);
    expect(electronMock.webContents.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/callback?code=ok",
    );
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  it("keeps safe cross-origin navigation inside a public Browser view", () => {
    createWebContentsView({
      window: {
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      } as never,
      partition: "persist:browser",
      allowedOrigins: ["https://matrix-os.com"],
      allowPublicNavigation: true,
      onState: vi.fn(),
    });
    const preventDefault = vi.fn();
    const navigate = electronMock.handlers.get("will-navigate");

    navigate?.({ preventDefault }, "https://developer.mozilla.org/en-US/");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(electronMock.webContents.loadURL).toHaveBeenCalledWith(
      "https://developer.mozilla.org/en-US/",
    );
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  it("opens HTTPS links requested by the hosted Shell in the system browser", () => {
    createWebContentsView({
      window: {
        contentView: {
          addChildView: vi.fn(),
          removeChildView: vi.fn(),
        },
      } as never,
      partition: "persist:home",
      allowedOrigins: ["https://app.matrix-os.com"],
      onState: vi.fn(),
    });

    const openHandler = electronMock.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler).toBeTypeOf("function");
    expect(openHandler?.({ url: "https://auth.openai.com/codex/device" })).toEqual({ action: "deny" });

    expect(electronMock.shell.openExternal).toHaveBeenCalledWith(
      "https://auth.openai.com/codex/device",
    );
  });

  it("opens an HTTP link requested by the hosted Shell without allowing unsafe schemes", () => {
    createWebContentsView({
      window: {
        contentView: {
          addChildView: vi.fn(),
          removeChildView: vi.fn(),
        },
      } as never,
      partition: "persist:home",
      allowedOrigins: ["https://app.matrix-os.com"],
      onState: vi.fn(),
    });

    const openHandler = electronMock.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler?.({ url: "http://localhost:3000/status" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "https://user:pass@example.com/private" })).toEqual({ action: "deny" });

    expect(electronMock.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith("http://localhost:3000/status");
  });
});
