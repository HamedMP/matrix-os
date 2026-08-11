import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebContentsView } from "@desktop/main/embeds/web-contents-view";

const electronMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const handlers = new Map<string, Handler>();
  const webContents = {
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
  }
  return {
    handlers,
    webContents,
    shell: { openExternal: vi.fn() },
    WebContentsView,
  };
});

vi.mock("electron", () => electronMock);

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.shell.openExternal.mockClear();
  electronMock.webContents.setWindowOpenHandler.mockClear();
});

describe("createWebContentsView", () => {
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
