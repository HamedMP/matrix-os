const mockFetchScope = jest.fn();
const mockFetchTerminal = jest.fn();
const mockControlTerminal = jest.fn();
const mockFetchTicket = jest.fn();

jest.mock("@/lib/requests/collaboration", () => ({
  collaborationTerminalUrl: jest.fn(() => "wss://app.matrix-os.com/ws/collaboration/terminal?ticket=test"),
  controlSharedTerminal: (...args: unknown[]) => mockControlTerminal(...args),
  fetchCollaborationEventTicket: (...args: unknown[]) => mockFetchTicket(...args),
  fetchCollaborationScope: (...args: unknown[]) => mockFetchScope(...args),
  fetchSharedTerminal: (...args: unknown[]) => mockFetchTerminal(...args),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SharedTerminalScreen } from "@/components/collaboration/SharedTerminalScreen";

const scopeId = "10000000-0000-4000-8000-000000000001";
const terminal = {
  id: "terminal_release",
  scopeId,
  incarnation: `terminal-${"a".repeat(32)}`,
  executionGeneration: "4",
  status: "active" as const,
  createdBy: { actorId: "user_owner", displayName: "Nima" },
  createdAt: "2026-09-11T12:00:00.000Z",
};

function scope(role: "owner" | "editor" | "viewer") {
  return {
    id: scopeId,
    ownerId: "user_owner",
    kind: "terminal" as const,
    resourceId: terminal.id,
    membershipMode: "direct" as const,
    lifecycle: "shared" as const,
    revision: "1",
    authEpoch: "1",
    authorityGeneration: "1",
    role,
    capabilities: {
      read: true,
      discuss: false,
      manageMembers: role === "owner",
      requestAi: false,
      observeTerminal: true,
      controlTerminal: role !== "viewer",
      stopTerminal: role === "owner",
    },
  };
}

type TestSocket = WebSocket & {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
};

const sockets: TestSocket[] = [];
const OriginalWebSocket = global.WebSocket;

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = TestWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = jest.fn();
  close = jest.fn(() => { this.readyState = TestWebSocket.CLOSED; });

  constructor() {
    sockets.push(this as unknown as TestSocket);
  }
}

function frame(type: "terminal.ready" | "terminal.output", extra: Record<string, unknown>, sequence = "1") {
  return JSON.stringify({
    version: 1,
    type,
    scopeId,
    resourceId: terminal.id,
    authorityGeneration: "1",
    incarnation: terminal.incarnation,
    sequence,
    ...extra,
  });
}

describe("native shared terminal screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sockets.length = 0;
    global.WebSocket = TestWebSocket as unknown as typeof WebSocket;
    mockFetchTicket.mockResolvedValue({ ticket: "t".repeat(43), expiresAt: "2026-09-11T12:00:30.000Z" });
    mockFetchTerminal.mockResolvedValue(terminal);
    mockControlTerminal.mockImplementation(async (_token: string, _scope: string, action: { type: string }) => ({
      terminal: action.type === "acquire" ? {
        ...terminal,
        controller: { actor: { actorId: "user_editor", displayName: "Ada" }, leaseEpoch: "7", expiresAt: "2026-09-11T12:00:30.000Z" },
      } : terminal,
      action: action.type === "acquire" ? "acquired" : "accepted",
    }));
  });

  afterAll(() => { global.WebSocket = OriginalWebSocket; });

  it("lets a viewer watch output without exposing terminal mutations", async () => {
    mockFetchScope.mockResolvedValue(scope("viewer"));
    const view = render(<SharedTerminalScreen scopeId={scopeId} actorId="user_viewer"
      getToken={async () => "clerk-token"} onBack={jest.fn()} />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => {
      sockets[0]!.onmessage?.({ data: frame("terminal.ready", { connectionId: "connection_viewer", terminal }) });
      sockets[0]!.onmessage?.({ data: frame("terminal.output", { data: "release ready\n" }, "2") });
    });

    expect(await screen.findByText(/release ready/)).toBeTruthy();
    expect(screen.getByText("Watching only")).toBeTruthy();
    expect(screen.queryByLabelText("Request control")).toBeNull();
    expect(screen.getByLabelText("Terminal input").props.editable).toBe(false);
    view.unmount();
  });

  it("binds editor input to the socket connection and current lease", async () => {
    mockFetchScope.mockResolvedValue(scope("editor"));
    const view = render(<SharedTerminalScreen scopeId={scopeId} actorId="user_editor"
      getToken={async () => "clerk-token"} onBack={jest.fn()} />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.onmessage?.({
      data: frame("terminal.ready", { connectionId: "connection_editor", terminal }),
    }));
    fireEvent.press(await screen.findByLabelText("Request control"));
    await waitFor(() => expect(mockControlTerminal).toHaveBeenCalledWith(
      "clerk-token",
      scopeId,
      expect.objectContaining({ type: "acquire", connectionId: "connection_editor", incarnation: terminal.incarnation }),
    ));
    fireEvent.changeText(screen.getByLabelText("Terminal input"), "pnpm test");
    fireEvent.press(screen.getByLabelText("Send input"));
    await waitFor(() => expect(mockControlTerminal).toHaveBeenCalledWith(
      "clerk-token",
      scopeId,
      expect.objectContaining({ type: "input", connectionId: "connection_editor", leaseEpoch: "7", data: "pnpm test" }),
    ));
    view.unmount();
  });

  it("offers takeover to the owner when an editor holds control", async () => {
    const controlled = {
      ...terminal,
      controller: { actor: { actorId: "user_editor", displayName: "Ada" }, leaseEpoch: "3", expiresAt: "2026-09-11T12:00:30.000Z" },
    };
    mockFetchScope.mockResolvedValue(scope("owner"));
    mockFetchTerminal.mockResolvedValue(controlled);
    mockControlTerminal.mockResolvedValue({ terminal: controlled, action: "taken_over" });
    const view = render(<SharedTerminalScreen scopeId={scopeId} actorId="user_owner"
      getToken={async () => "clerk-token"} onBack={jest.fn()} />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.onmessage?.({
      data: frame("terminal.ready", { connectionId: "connection_owner", terminal: controlled }),
    }));
    fireEvent.press(await screen.findByLabelText("Take control from Ada"));
    await waitFor(() => expect(mockControlTerminal).toHaveBeenCalledWith(
      "clerk-token",
      scopeId,
      expect.objectContaining({ type: "takeover", connectionId: "connection_owner" }),
    ));
    view.unmount();
  });
});
