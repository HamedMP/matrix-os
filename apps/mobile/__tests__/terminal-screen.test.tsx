import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import TerminalScreen from "../app/terminal";
import { useGateway } from "@/app/_layout";
import type { GatewayClient } from "../lib/gateway-client";

const SESSION_ID = "c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9";

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

    await waitFor(() => expect(screen.getByLabelText("Resume ~/projects")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("New session"));

    await waitFor(() => expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledWith("ws-token"));
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
    expect(screen.getByText("deploy@matrix:~/projects$ ")).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText("command"), "pwd");
    fireEvent.press(screen.getByLabelText("Run command"));

    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual(
      expect.arrayContaining([
        { type: "attach", cwd: "projects" },
        { type: "input", data: "pwd\r" },
      ]),
    );
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

    await waitFor(() => expect(screen.getByLabelText("Continue terminal ~/projects")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("Continue terminal ~/projects"));

    await waitFor(() => expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledWith("ws-token"));
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

    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual(
      expect.arrayContaining([{ type: "attach", sessionId: SESSION_ID }]),
    );
  });

  it("reattaches to the active terminal session from the last replay cursor", async () => {
    global.WebSocket = {
      OPEN: 1,
      CLOSED: 3,
    } as typeof WebSocket;
    const firstSocket = new MockTerminalSocket();
    const secondSocket = new MockTerminalSocket();
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
      getWsToken: jest.fn().mockResolvedValue("ws-token"),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest
        .fn()
        .mockReturnValueOnce(firstSocket as unknown as WebSocket)
        .mockReturnValueOnce(secondSocket as unknown as WebSocket),
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

    await waitFor(() => expect(screen.getByLabelText("Resume ~/projects")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("Resume ~/projects"));
    await waitFor(() => expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledTimes(1));

    await act(async () => {
      firstSocket.onopen?.();
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "attached",
          sessionId: SESSION_ID,
          cwd: "/home/matrix/home/projects",
        }),
      });
      firstSocket.onmessage?.({
        data: JSON.stringify({ type: "output", data: "first\n", seq: 7 }),
      });
      firstSocket.onmessage?.({
        data: JSON.stringify({ type: "replay-end", toSeq: 8 }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.press(screen.getByLabelText("Resume ~/projects"));
    await waitFor(() => expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondSocket.onopen?.();
      await Promise.resolve();
    });

    expect(secondSocket.sent.map((frame) => JSON.parse(frame))).toEqual(
      expect.arrayContaining([{ type: "attach", sessionId: SESSION_ID, fromSeq: 8 }]),
    );
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

    expect(gatewayClient.getWsToken).toHaveBeenCalledTimes(1);

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

    await waitFor(() => expect(screen.getByLabelText("Continue terminal ~/projects")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("Continue terminal ~/projects"));
    await waitFor(() => expect(gatewayClient.openTerminalWebSocket).toHaveBeenCalledWith("ws-token"));

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

    await waitFor(() => expect(screen.getByPlaceholderText("command")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("Destroy session"));

    await waitFor(() => expect(gatewayClient.deleteTerminalSession).toHaveBeenCalledWith(SESSION_ID));
    expect(socket.closed).toBe(false);
    expect(AsyncStorage.setItem).not.toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('"lastActiveTerminalSessionId":null'),
    );
  });

  it("shows safe recovery when the persisted terminal session is gone", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "terminal",
      lastActiveTerminalSessionId: SESSION_ID,
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    const gatewayClient = {
      getTerminalSessions: jest.fn().mockResolvedValue([
        {
          sessionId: "550e8400-e29b-41d4-a716-446655440000",
          cwd: "/home/matrix/home/projects",
          state: "running",
        },
      ]),
      getWsToken: jest.fn(),
      setWebSocketToken: jest.fn(),
      openTerminalWebSocket: jest.fn(),
      deleteTerminalSession: jest.fn(),
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

    await waitFor(() => expect(screen.getByText("Last terminal ended. Start a new session to continue.")).toBeTruthy());
    expect(screen.queryByLabelText("Continue terminal ~/projects")).toBeNull();
  });
});
