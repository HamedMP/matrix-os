import { describe, expect, it, vi } from "vitest";
import {
  createCollaborationTerminalWebSocketUrl,
  watchCollaborationTerminal,
} from "../../packages/sync-client/src/cli/commands/collaboration.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const incarnation = `terminal-${"a".repeat(32)}`;

class FakeSocket {
  static instance: FakeSocket | null = null;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  constructor(readonly url: string) { FakeSocket.instance = this; }
  on(event: string, listener: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  send(value: string) { this.sent.push(value); }
  close() { this.emit("close"); }
  emit(event: string, ...args: unknown[]) { for (const listener of this.listeners[event] ?? []) listener(...args); }
}

function terminal(controller?: { actorId: string; displayName: string; leaseEpoch: string }) {
  return {
    id: "terminal_release", scopeId, incarnation, executionGeneration: "4", status: "active" as const,
    createdBy: { actorId: "user_owner", displayName: "Nima" },
    ...(controller ? { controller: { actor: { actorId: controller.actorId, displayName: controller.displayName },
      leaseEpoch: controller.leaseEpoch, expiresAt: "2026-09-11T12:00:30.000Z" } } : {}),
    createdAt: "2026-09-11T12:00:00.000Z",
  };
}

function frame(type: "terminal.ready" | "terminal.state", current: ReturnType<typeof terminal>) {
  return {
    version: 1,
    type,
    ...(type === "terminal.ready" ? { connectionId: "connection_cli" } : {}),
    scopeId,
    resourceId: "terminal_release",
    authorityGeneration: "1",
    incarnation,
    sequence: "0",
    terminal: current,
  };
}

describe("CLI shared terminal", () => {
  it("builds an exact ticket-only terminal WebSocket URL", () => {
    expect(createCollaborationTerminalWebSocketUrl("https://app.matrix-os.com", scopeId, "t".repeat(43)))
      .toBe(`wss://app.matrix-os.com/ws/collaboration/scopes/${scopeId}/terminal?ticket=${"t".repeat(43)}`);
    expect(() => createCollaborationTerminalWebSocketUrl("https://user:secret@app.matrix-os.com", scopeId, "t".repeat(43)))
      .toThrow();
  });

  it("acquires, sends, and releases one input with issued connection and lease fences", async () => {
    const request = vi.fn(async () => ({ ticket: "t".repeat(43), expiresAt: "2026-09-11T12:00:30.000Z" }));
    const watching = watchCollaborationTerminal({
      platformUrl: "https://app.matrix-os.com",
      token: "actor-token",
      scopeId,
      control: "acquire",
      input: "pnpm test",
      request,
      WebSocketImpl: FakeSocket as never,
      writeOutput: vi.fn(),
      writeState: vi.fn(),
    });
    await vi.waitFor(() => expect(FakeSocket.instance).not.toBeNull());
    const socket = FakeSocket.instance!;
    socket.emit("open");
    socket.emit("message", JSON.stringify(frame("terminal.ready", terminal())));
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "acquire", connectionId: "connection_cli", incarnation,
    });
    socket.emit("message", JSON.stringify(frame("terminal.state", terminal({
      actorId: "user_editor", displayName: "Ada", leaseEpoch: "7",
    }))));
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: "input", connectionId: "connection_cli", leaseEpoch: "7", data: "pnpm test",
    });
    socket.emit("message", JSON.stringify(frame("terminal.state", terminal({
      actorId: "user_editor", displayName: "Ada", leaseEpoch: "7",
    }))));
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({
      type: "release", connectionId: "connection_cli", leaseEpoch: "7",
    });
    socket.emit("message", JSON.stringify(frame("terminal.state", terminal())));
    await expect(watching).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/connection-tickets`,
      body: expect.objectContaining({ purpose: "terminal" }),
    }));
  });
});
