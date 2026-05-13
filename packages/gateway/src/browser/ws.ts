import {
  BROWSER_STREAM_PROTOCOL_VERSION,
  assertBrowserMessageSize,
  parseBrowserClientMessage,
  type BrowserClientMessage,
} from "@matrix-os/mcp-browser/stream-protocol";
import {
  assertRelayIceCandidate,
  createBrowserMediaOffer,
  createEphemeralTurnCredential,
  DEFAULT_BROWSER_MEDIA_BUDGET,
  type BrowserMediaOffer,
} from "@matrix-os/mcp-browser/media-service";

export function parseBrowserWsMessage(raw: string | Buffer): BrowserClientMessage {
  assertBrowserMessageSize(raw);
  const value = JSON.parse(raw.toString());
  return parseBrowserClientMessage(value);
}

export function browserTakenOverMessage() {
  return {
    type: "stream.taken_over",
    payload: {
      message: "Browser was opened on another device.",
    },
  } as const;
}

export type BrowserServerMessage =
  | {
    type: "stream.ready";
    payload: {
      protocolVersion: number;
      ownerId: string;
      sessionId: string;
      mediaMode: "webrtc";
      audio: { muted: boolean };
      budgets: { maxWidth: number; maxHeight: number; maxFrameRate: number; maxBitrateKbps: number };
      turnCredentialExpiresAt?: string;
    };
  }
  | BrowserMediaOffer
  | { type: "media.ready"; payload: { sessionId: string } }
  | { type: "media.ice.accepted"; payload: { candidate: string } }
  | { type: "navigation.committed"; payload: { url: string } }
  | { type: "surface.focused"; payload: { surfaceId: string } }
  | { type: "stream.error"; payload: { code: string; message: string } };

export interface BrowserStreamSender {
  send(message: string): void;
  close?(): void;
}

export interface BrowserStreamConnection {
  id: string;
  ownerId: string;
  sessionId: string;
  surfaceId?: string;
  sender: BrowserStreamSender;
  lastTouchedAt: number;
}

export class BrowserStreamHub {
  private readonly connections = new Map<string, BrowserStreamConnection>();

  constructor(private readonly opts: {
    maxConnections?: number;
    staleMs?: number;
    now?: () => number;
  } = {}) {}

  register(input: {
    id: string;
    ownerId: string;
    sessionId: string;
    sender: BrowserStreamSender;
    surfaceId?: string;
  }): void {
    this.sweepStale();
    const now = this.now();
    this.connections.set(input.id, {
      ...input,
      lastTouchedAt: now,
    });
    this.evictOverflow();
  }

  touch(id: string, surfaceId?: string): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.lastTouchedAt = this.now();
    if (surfaceId) {
      connection.surfaceId = surfaceId;
    }
  }

  unregister(id: string): void {
    this.connections.delete(id);
  }

  size(): number {
    return this.connections.size;
  }

  sweepStale(): number {
    const cutoff = this.now() - (this.opts.staleMs ?? 30_000);
    let removed = 0;
    for (const [id, connection] of this.connections.entries()) {
      if (connection.lastTouchedAt <= cutoff) {
        this.closeConnection(connection);
        this.connections.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  broadcastSession(sessionId: string, message: BrowserServerMessage | ReturnType<typeof browserTakenOverMessage>): number {
    let delivered = 0;
    const payload = JSON.stringify(message);
    const dead: string[] = [];
    for (const [id, connection] of this.connections.entries()) {
      if (connection.sessionId !== sessionId) continue;
      try {
        connection.sender.send(payload);
        delivered += 1;
      } catch (error: unknown) {
        console.warn("[browser/ws] Broadcast send failed:", error instanceof Error ? error.message : String(error));
        dead.push(id);
      }
    }
    for (const id of dead) {
      this.closeConnection(this.connections.get(id));
      this.connections.delete(id);
    }
    return delivered;
  }

  notifySessionTakenOver(sessionId: string): number {
    let delivered = 0;
    const payload = JSON.stringify(browserTakenOverMessage());
    for (const [id, connection] of this.connections.entries()) {
      if (connection.sessionId !== sessionId) continue;
      try {
        connection.sender.send(payload);
        delivered += 1;
      } catch (error: unknown) {
        console.warn("[browser/ws] Takeover notification failed:", error instanceof Error ? error.message : String(error));
      } finally {
        this.closeConnection(connection);
        this.connections.delete(id);
      }
    }
    return delivered;
  }

  notifySessionClosed(sessionId: string, state = "closed"): number {
    const message: BrowserServerMessage = {
      type: "stream.error",
      payload: {
        code: state === "hibernated" ? "idle_hibernated" : "session_closed",
        message: "Browser session closed.",
      },
    };
    const payload = JSON.stringify(message);
    let delivered = 0;
    for (const [id, connection] of this.connections.entries()) {
      if (connection.sessionId !== sessionId) continue;
      try {
        connection.sender.send(payload);
        delivered += 1;
      } catch (error: unknown) {
        console.warn("[browser/ws] Close notification failed:", error instanceof Error ? error.message : String(error));
      } finally {
        this.closeConnection(connection);
        this.connections.delete(id);
      }
    }
    return delivered;
  }

  closeAll(message: BrowserServerMessage | ReturnType<typeof browserTakenOverMessage> = {
    type: "stream.error",
    payload: {
      code: "shutdown",
      message: "Browser stream is shutting down.",
    },
  }): void {
    const payload = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      try {
        connection.sender.send(payload);
      } catch (error: unknown) {
        console.warn("[browser/ws] Shutdown notification failed:", error instanceof Error ? error.message : String(error));
      } finally {
        this.closeConnection(connection);
      }
    }
    this.connections.clear();
  }

  private evictOverflow(): void {
    const maxConnections = this.opts.maxConnections ?? 128;
    while (this.connections.size > maxConnections) {
      const oldest = [...this.connections.values()].sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)[0];
      if (!oldest) return;
      this.closeConnection(oldest);
      this.connections.delete(oldest.id);
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private closeConnection(connection: BrowserStreamConnection | undefined): void {
    try {
      connection?.sender.close?.();
    } catch (error: unknown) {
      console.warn("[browser/ws] Close failed:", error instanceof Error ? error.message : String(error));
    }
  }
}

export class BrowserStreamController {
  private focusedSurfaceId: string | undefined;

  constructor(private readonly opts: {
    ownerId: string;
    sessionId: string;
    turnUrls?: string[];
    turnSecret?: string;
    createOfferSdp?: () => string;
  }) {}

  handleClientMessage(raw: string | Buffer, context: { surfaceId?: string } = {}): BrowserServerMessage[] {
    const message = parseBrowserWsMessage(raw);
    if (message.type === "stream.hello") {
      this.focusedSurfaceId ??= message.payload.surfaceId;
      if (this.opts.turnUrls && this.opts.turnUrls.length > 0 && !this.opts.turnSecret) {
        return [{
          type: "stream.error",
          payload: { code: "media_policy", message: "Browser media relay is unavailable." },
        }];
      }
      const turnCredential = this.opts.turnUrls && this.opts.turnUrls.length > 0
        ? createEphemeralTurnCredential({
          ownerId: this.opts.ownerId,
          sessionId: this.opts.sessionId,
          urls: this.opts.turnUrls,
          secret: this.opts.turnSecret as string,
        })
        : undefined;
      const messages: BrowserServerMessage[] = [
        {
          type: "stream.ready",
          payload: {
            protocolVersion: BROWSER_STREAM_PROTOCOL_VERSION,
            ownerId: this.opts.ownerId,
            sessionId: this.opts.sessionId,
            mediaMode: "webrtc",
            audio: { muted: DEFAULT_BROWSER_MEDIA_BUDGET.muted },
            budgets: {
              maxWidth: DEFAULT_BROWSER_MEDIA_BUDGET.maxWidth,
              maxHeight: DEFAULT_BROWSER_MEDIA_BUDGET.maxHeight,
              maxFrameRate: DEFAULT_BROWSER_MEDIA_BUDGET.maxFrameRate,
              maxBitrateKbps: DEFAULT_BROWSER_MEDIA_BUDGET.maxBitrateKbps,
            },
            ...(turnCredential ? { turnCredentialExpiresAt: turnCredential.expiresAt } : {}),
          },
        },
      ];
      if (turnCredential) {
        messages.push(createBrowserMediaOffer({
          sdp: this.opts.createOfferSdp?.() ?? "v=0\r\ns=Matrix Browser\r\nt=0 0\r\n",
          turn: turnCredential,
        }));
      }
      messages.push({
        type: "surface.focused",
        payload: { surfaceId: this.focusedSurfaceId },
      });
      return messages;
    }

    if (message.type === "media.answer") {
      return [{ type: "media.ready", payload: { sessionId: this.opts.sessionId } }];
    }

    if (message.type === "media.ice") {
      assertRelayIceCandidate(message.payload.candidate);
      return [{ type: "media.ice.accepted", payload: { candidate: message.payload.candidate } }];
    }

    if (message.type === "surface.focus") {
      this.focusedSurfaceId = message.payload.surfaceId;
      return [{ type: "surface.focused", payload: { surfaceId: message.payload.surfaceId } }];
    }

    if (isInputMessage(message) && context.surfaceId && this.focusedSurfaceId !== context.surfaceId) {
      return [{
        type: "stream.error",
        payload: {
          code: "stale_focus",
          message: "Browser input came from a background surface.",
        },
      }];
    }

    return [];
  }
}

function isInputMessage(message: BrowserClientMessage): boolean {
  return message.type === "input.pointer" ||
    message.type === "input.keyboard" ||
    message.type === "input.ime" ||
    message.type === "input.paste";
}
