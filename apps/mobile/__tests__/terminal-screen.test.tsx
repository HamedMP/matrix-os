import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, StyleSheet, View } from "react-native";
import TerminalScreen from "../app/(tabs)/terminal";
import { useGateway } from "@/app/_layout";
import type { GatewayClient } from "../lib/gateway-client";
import {
  emitWebViewMessage,
  latestWebViewSource,
  resetWebViewMock,
  webViewInjections,
} from "../__mocks__/react-native-webview";

const SESSION_ID = "matrix-abc1234";

// Auto-confirm the End-session / Detach confirmation dialogs in tests.
function autoConfirmAlerts() {
  jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    const confirm = buttons?.find((b) => b.style === "destructive") ?? buttons?.[buttons.length - 1];
    confirm?.onPress?.();
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: jest.fn() }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

class MockTerminalSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("TerminalScreen", () => {
  const OriginalWebSocket = global.WebSocket;

  afterEach(() => {
    global.WebSocket = OriginalWebSocket;
    jest.clearAllMocks();
    resetWebViewMock();
  });

  it("opens a mobile terminal session with visible path, output, and command input", async () => {
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    const socket = new MockTerminalSocket();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([
        {
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
          state: "running",
        },
      ]),
      createTerminalSession: jest.fn().mockResolvedValue(SESSION_ID),
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
      deleteTerminalSession: jest.fn().mockResolvedValue(true),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: gatewayClient as unknown as GatewayClient,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<TerminalScreen />);

    // The terminal lands on a running session automatically (last-session-first).
    await waitFor(() =>
      expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledWith("ws-token", SESSION_ID, undefined),
    );
    await act(async () => {
      socket.onopen?.();
      socket.onmessage?.({
        data: JSON.stringify({
          type: "attached",
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
        }),
      });
      socket.onmessage?.({
        data: JSON.stringify({ type: "output", data: "deploy@matrix:~/projects$ " }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getAllByText("~/projects").length).toBeGreaterThan(0));
    // Output is written into the embedded xterm.js emulator (WebView), not a Text node.
    await waitFor(() =>
      expect(webViewInjections.some((js: string) => js.includes("deploy@matrix:~/projects$ "))).toBe(true),
    );

    // No command bar anymore — the user types directly into xterm, which posts
    // an "input" frame that the screen forwards over the WebSocket.
    await act(async () => {
      emitWebViewMessage({ type: "input", data: "pwd\r" });
      await Promise.resolve();
    });

    const sent = socket.sent.map((frame) => JSON.parse(frame));
    // No attach frame anymore — the session name is supplied in the WS query.
    expect(sent.some((frame) => frame.type === "attach")).toBe(false);
    expect(sent).toContainEqual({ type: "input", data: "pwd\r" });
  });

  it("leaves terminal touch handling with the WebView instead of a full-surface responder overlay", async () => {
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    const socket = new MockTerminalSocket();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([
        {
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
          state: "running",
        },
      ]),
      createTerminalSession: jest.fn().mockResolvedValue(SESSION_ID),
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
      deleteTerminalSession: jest.fn().mockResolvedValue(true),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: gatewayClient as unknown as GatewayClient,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    const rendered = render(<TerminalScreen />);

    await waitFor(() => expect(screen.getByTestId("terminal-webview")).toBeTruthy());
    const responderOverlays = rendered.UNSAFE_queryAllByType(View).filter((node) => {
      const style = StyleSheet.flatten(node.props.style);
      return (
        (typeof node.props.onStartShouldSetResponder === "function" ||
          typeof node.props.onMoveShouldSetResponder === "function") &&
        style?.position === "absolute" &&
        style?.top === 0 &&
        style?.right === 0 &&
        style?.bottom === 0 &&
        style?.left === 0 &&
        style?.backgroundColor === "transparent"
      );
    });
    expect(responderOverlays).toHaveLength(0);
    // The emulator owns pan gestures via the in-document touch→wheel bridge so
    // alternate-screen TUIs receive scroll too; no RN responder overlay exists.
    const html = (latestWebViewSource as { html?: string } | null)?.html ?? "";
    expect(html).toContain("touch-action: none");
    expect(html).toContain("touchmove");
    expect(html).toContain("WheelEvent");
  });

  it("offers a real continue action for the persisted terminal session", async () => {
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    const socket = new MockTerminalSocket();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "terminal",
      lastActiveTerminalSessionId: SESSION_ID,
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([
        {
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
          state: "running",
        },
      ]),
      createTerminalSession: jest.fn().mockResolvedValue(SESSION_ID),
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
      deleteTerminalSession: jest.fn().mockResolvedValue(true),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: gatewayClient as unknown as GatewayClient,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<TerminalScreen />);

    // Remembered session auto-attaches by name on open (no create, no attach frame).
    await waitFor(() =>
      expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledWith("ws-token", SESSION_ID, undefined),
    );
    expect(gatewayClient.createTerminalSession).not.toHaveBeenCalled();
    await act(async () => {
      socket.onopen?.();
      socket.onmessage?.({
        data: JSON.stringify({
          type: "attached",
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(socket.sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "attach")).toBe(false);
  });

  it("ignores duplicate connect actions while a terminal connection is pending", async () => {
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    const socket = new MockTerminalSocket();
    const tokenRequest = createDeferred<string>();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([]),
      createTerminalSession: jest.fn().mockResolvedValue(SESSION_ID),
      getWsToken: jest.fn(() => tokenRequest.promise),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
      deleteTerminalSession: jest.fn().mockResolvedValue(true),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: gatewayClient as unknown as GatewayClient,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<TerminalScreen />);

    const newSession = screen.getByLabelText("New session");
    fireEvent.press(newSession);
    fireEvent.press(newSession);

    // The in-flight guard collapses the duplicate press: only one session is created.
    expect(gatewayClient.createTerminalSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      tokenRequest.resolve("ws-token");
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledTimes(1));
  });

  it("keeps terminal recovery state when deleting a session fails", async () => {
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    const socket = new MockTerminalSocket();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "terminal",
      lastActiveTerminalSessionId: SESSION_ID,
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([
        {
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
          state: "running",
        },
      ]),
      createTerminalSession: jest.fn().mockResolvedValue(SESSION_ID),
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
      deleteTerminalSession: jest.fn().mockResolvedValue(false),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: gatewayClient as unknown as GatewayClient,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<TerminalScreen />);

    // The terminal auto-attaches to the last running session on open.
    await waitFor(() =>
      expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledWith("ws-token", SESSION_ID, undefined),
    );

    await act(async () => {
      socket.onopen?.();
      socket.onmessage?.({
        data: JSON.stringify({
          type: "attached",
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // End session sits in the header behind a confirmation dialog.
    await waitFor(() => expect(screen.getByLabelText("End session")).toBeTruthy());
    autoConfirmAlerts();
    fireEvent.press(screen.getByLabelText("End session"));

    await waitFor(() => expect(gatewayClient.deleteTerminalSession).toHaveBeenCalledWith(SESSION_ID));
    expect(socket.closed).toBe(false);
    expect(AsyncStorage.setItem).not.toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('"lastActiveTerminalSessionId":null'),
    );
  });

  it("falls back to an available running session when the persisted one is gone", async () => {
    const AVAILABLE = "matrix-1a2b3c4";
    global.WebSocket = { OPEN: 1, CLOSED: 3 } as typeof WebSocket;
    const socket = new MockTerminalSocket();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "terminal",
      lastActiveTerminalSessionId: SESSION_ID,
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([
        { sessionId: AVAILABLE, cwd: "/home/matrix/home/projects", state: "running", visualStatus: "running" },
      ]),
      createTerminalSession: jest.fn().mockResolvedValue(AVAILABLE),
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
      deleteTerminalSession: jest.fn().mockResolvedValue(true),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: gatewayClient as unknown as GatewayClient,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<TerminalScreen />);

    // The persisted session is gone, so it auto-attaches to the available one.
    await waitFor(() =>
      expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledWith("ws-token", AVAILABLE, undefined),
    );
    expect(gatewayClient.createTerminalSession).not.toHaveBeenCalled();
  });

  it("does not fall back to another running session when an explicit terminal handoff is stale", async () => {
    const AVAILABLE = "matrix-1a2b3c4";
    global.WebSocket = { OPEN: 1, CLOSED: 3 } as typeof WebSocket;
    const socket = new MockTerminalSocket();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "terminal",
      lastActiveTerminalSessionId: SESSION_ID,
      terminalHandoffSessionId: SESSION_ID,
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([
        { sessionId: AVAILABLE, cwd: "/home/matrix/home/projects", state: "running", visualStatus: "running" },
      ]),
      createTerminalSession: jest.fn().mockResolvedValue(AVAILABLE),
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(() => socket as unknown as WebSocket),
      deleteTerminalSession: jest.fn().mockResolvedValue(true),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: gatewayClient as unknown as GatewayClient,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<TerminalScreen />);

    expect(await screen.findByText("Terminal unavailable")).toBeTruthy();
    expect(gatewayClient.openTerminalWebSocket).not.toHaveBeenCalledWith("ws-token", AVAILABLE, undefined);
    expect(gatewayClient.createTerminalSession).not.toHaveBeenCalled();
  });
});
