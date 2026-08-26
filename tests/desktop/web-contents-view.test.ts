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
    loadURL: vi.fn(),
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
  electronMock.webContents.session.setPermissionCheckHandler.mockClear();
  electronMock.webContents.session.setPermissionRequestHandler.mockClear();
});

describe("createWebContentsView", () => {
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
