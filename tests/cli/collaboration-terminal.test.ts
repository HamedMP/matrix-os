import { describe, expect, it, vi } from "vitest";
import {
  isCollaborationPathAllowed,
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
  it("allows only exact decline and generic discussion request paths", () => {
    expect(isCollaborationPathAllowed(`/api/collaboration/invitations/30000000-0000-4000-8000-000000000001/decline`))
      .toBe(true);
    expect(isCollaborationPathAllowed(`/api/collaboration/scopes/${scopeId}/discussion/messages?after=0&limit=50`))
      .toBe(true);
    expect(isCollaborationPathAllowed(`/api/collaboration/scopes/${scopeId}/discussion/user-state`))
      .toBe(true);
    expect(isCollaborationPathAllowed(`/api/collaboration/scopes/${scopeId}/discussion/messages/private`))
      .toBe(false);
    expect(isCollaborationPathAllowed(`/api/collaboration/scopes/${scopeId}/connection-tickets`))
      .toBe(false);
  });

  it("opens a direct terminal stream with a possession handshake, then preserves lease fences", async () => {
    const transport = { terminal: vi.fn(async () => ({
      url: `wss://relay.matrix-os.com/ws/collaboration/direct/scopes/${scopeId}/terminal?ticket=opaque&after=0`,
      actorId: "user_editor",
      handshake: JSON.stringify({ protocolVersion: 2, type: "handshake", sessionId: "session", ticketNonce: "nonce", possession: "proof" }),
    })) };
    const watching = watchCollaborationTerminal({
      platformUrl: "https://app.matrix-os.com",
      token: "actor-token",
      scopeId,
      control: "acquire",
      input: "pnpm test",
      transport: transport as never,
      WebSocketImpl: FakeSocket as never,
      writeOutput: vi.fn(),
      writeState: vi.fn(),
    });
    await vi.waitFor(() => expect(FakeSocket.instance).not.toBeNull());
    const socket = FakeSocket.instance!;
    expect(socket.url).toContain(`/ws/collaboration/direct/scopes/${scopeId}/terminal`);
    socket.emit("open");
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "handshake", sessionId: "session" });
    socket.emit("message", JSON.stringify(frame("terminal.ready", terminal())));
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: "acquire", connectionId: "connection_cli", incarnation,
    });
    socket.emit("message", JSON.stringify(frame("terminal.state", terminal({
      actorId: "user_other", displayName: "Grace", leaseEpoch: "6",
    }))));
    expect(socket.sent).toHaveLength(2);
    socket.emit("message", JSON.stringify(frame("terminal.state", terminal({
      actorId: "user_editor", displayName: "Ada", leaseEpoch: "7",
    }))));
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({
      type: "input", connectionId: "connection_cli", leaseEpoch: "7", data: "pnpm test",
    });
    socket.emit("message", JSON.stringify(frame("terminal.state", terminal({
      actorId: "user_editor", displayName: "Ada", leaseEpoch: "7",
    }))));
    expect(JSON.parse(socket.sent[3]!)).toMatchObject({
      type: "release", connectionId: "connection_cli", leaseEpoch: "7",
    });
    socket.emit("message", JSON.stringify(frame("terminal.state", terminal())));
    await expect(watching).resolves.toBeUndefined();
    expect(transport.terminal).toHaveBeenCalledWith(scopeId);
  });
});
