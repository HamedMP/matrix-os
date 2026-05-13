import { describe, expect, it } from "vitest";
import {
  BROWSER_STREAM_PROTOCOL_VERSION,
  MAX_FALLBACK_FRAME_QUEUE,
  MAX_STREAM_MESSAGE_BYTES,
  parseBrowserClientMessage,
} from "../../packages/mcp-browser/src/stream-protocol.js";
import { BrowserStreamController, BrowserStreamHub, browserTakenOverMessage, parseBrowserWsMessage } from "../../packages/gateway/src/browser/ws.js";

const hello = {
  type: "stream.hello",
  payload: {
    protocolVersion: BROWSER_STREAM_PROTOCOL_VERSION,
    surfaceId: "surface_1",
    surface: "canvas",
    deviceId: "device_1",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    media: {
      preferredMode: "webrtc",
      audio: true,
      fallbackFrames: true,
      iceTransportPolicy: "relay",
    },
  },
} as const;

describe("Browser stream protocol", () => {
  it("accepts the current stream protocol version", () => {
    expect(parseBrowserClientMessage(hello)).toEqual(hello);
  });

  it("rejects unsupported protocol versions with upgrade_required", () => {
    expect(() => parseBrowserClientMessage({
      ...hello,
      payload: { ...hello.payload, protocolVersion: BROWSER_STREAM_PROTOCOL_VERSION + 1 },
    })).toThrow("upgrade_required");
  });

  it("rejects oversize WebSocket frames before parsing", () => {
    expect(() => parseBrowserWsMessage(Buffer.alloc(MAX_STREAM_MESSAGE_BYTES + 1))).toThrow("message_too_large");
  });

  it("validates frame payloads through bounded Zod schemas", () => {
    expect(() => parseBrowserWsMessage(JSON.stringify({
      type: "input.paste",
      payload: { text: "x".repeat(16 * 1024 + 1) },
    }))).toThrow();
  });

  it("documents the bounded fallback-frame queue contract", () => {
    expect(MAX_FALLBACK_FRAME_QUEUE).toBe(3);
  });

  it("has an explicit takeover server message", () => {
    expect(browserTakenOverMessage()).toEqual({
      type: "stream.taken_over",
      payload: { message: "Browser was opened on another device." },
    });
  });

  it("negotiates stream ready, server media offer, and focused surface messages", () => {
    const controller = new BrowserStreamController({
      ownerId: "owner_1",
      sessionId: "session_1",
      turnUrls: ["turn:turn.matrix.test:3478?transport=udp"],
      turnSecret: "turn-secret",
      createOfferSdp: () => "v=0\r\ns=browser\r\nt=0 0\r\n",
    });
    expect(controller.handleClientMessage(JSON.stringify(hello))).toEqual([
      {
        type: "stream.ready",
        payload: expect.objectContaining({
          protocolVersion: BROWSER_STREAM_PROTOCOL_VERSION,
          sessionId: "session_1",
          mediaMode: "webrtc",
          turnCredentialExpiresAt: expect.any(String),
        }),
      },
      {
        type: "media.offer",
        payload: expect.objectContaining({
          sdp: "v=0\r\ns=browser\r\nt=0 0\r\n",
          iceTransportPolicy: "relay",
          iceServers: [
            expect.objectContaining({
              urls: ["turn:turn.matrix.test:3478?transport=udp"],
              username: expect.stringContaining(":owner_1:session_1:"),
              credential: expect.not.stringMatching(/^turn-secret$/),
            }),
          ],
        }),
      },
      {
        type: "surface.focused",
        payload: { surfaceId: "surface_1" },
      },
    ]);
  });

  it("rejects TURN configuration without a relay secret", () => {
    const controller = new BrowserStreamController({
      ownerId: "owner_1",
      sessionId: "session_1",
      turnUrls: ["turn:turn.matrix.test:3478?transport=udp"],
    });
    expect(controller.handleClientMessage(JSON.stringify(hello))).toEqual([
      {
        type: "stream.error",
        payload: { code: "media_policy", message: "Browser media relay is unavailable." },
      },
    ]);
  });

  it("accepts only relay ICE candidates from clients", () => {
    const controller = new BrowserStreamController({ ownerId: "owner_1", sessionId: "session_1" });
    expect(controller.handleClientMessage(JSON.stringify({
      type: "media.ice",
      payload: { candidate: "candidate:1 1 udp 1 203.0.113.10 5000 typ relay" },
    }))).toEqual([
      {
        type: "media.ice.accepted",
        payload: { candidate: "candidate:1 1 udp 1 203.0.113.10 5000 typ relay" },
      },
    ]);
    expect(() => controller.handleClientMessage(JSON.stringify({
      type: "media.ice",
      payload: { candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host" },
    }))).toThrow("media_policy");
  });

  it("rejects input from stale focus surfaces", () => {
    const controller = new BrowserStreamController({ ownerId: "owner_1", sessionId: "session_1" });
    controller.handleClientMessage(JSON.stringify(hello));
    controller.handleClientMessage(JSON.stringify({
      type: "surface.focus",
      payload: { surfaceId: "surface_2", reason: "programmatic" },
    }), { surfaceId: "surface_2" });

    expect(controller.handleClientMessage(JSON.stringify({
      type: "input.pointer",
      payload: { kind: "down", x: 1, y: 1, button: "left", modifiers: [] },
    }), { surfaceId: "surface_1" })).toEqual([
      {
        type: "stream.error",
        payload: { code: "stale_focus", message: "Browser input came from a background surface." },
      },
    ]);
  });

  it("evicts stale streams and closes them", () => {
    let now = 1_000;
    const closed: string[] = [];
    const hub = new BrowserStreamHub({ staleMs: 100, now: () => now });
    hub.register({
      id: "conn_1",
      ownerId: "owner_1",
      sessionId: "session_1",
      sender: {
        send() {},
        close: () => closed.push("conn_1"),
      },
    });

    now = 1_101;
    expect(hub.sweepStale()).toBe(1);
    expect(hub.size()).toBe(0);
    expect(closed).toEqual(["conn_1"]);
  });

  it("evicts failed broadcast senders while continuing delivery", () => {
    const delivered: string[] = [];
    const hub = new BrowserStreamHub();
    hub.register({
      id: "bad",
      ownerId: "owner_1",
      sessionId: "session_1",
      sender: {
        send() {
          throw new Error("closed");
        },
      },
    });
    hub.register({
      id: "good",
      ownerId: "owner_1",
      sessionId: "session_1",
      sender: {
        send(message) {
          delivered.push(message);
        },
      },
    });

    expect(hub.broadcastSession("session_1", browserTakenOverMessage())).toBe(1);
    expect(hub.size()).toBe(1);
    expect(JSON.parse(delivered[0] ?? "{}")).toEqual(browserTakenOverMessage());
  });

  it("notifies and closes old streams after takeover", () => {
    const delivered: string[] = [];
    const closed: string[] = [];
    const hub = new BrowserStreamHub();
    hub.register({
      id: "old",
      ownerId: "owner_1",
      sessionId: "session_1",
      sender: {
        send(message) {
          delivered.push(message);
        },
        close() {
          closed.push("old");
        },
      },
    });

    expect(hub.notifySessionTakenOver("session_1")).toBe(1);
    expect(hub.size()).toBe(0);
    expect(closed).toEqual(["old"]);
    expect(JSON.parse(delivered[0] ?? "{}")).toEqual(browserTakenOverMessage());
  });

  it("drains all browser streams on shutdown", () => {
    const sent: string[] = [];
    const closed: string[] = [];
    const hub = new BrowserStreamHub();
    hub.register({
      id: "conn_1",
      ownerId: "owner_1",
      sessionId: "session_1",
      sender: {
        send(message) {
          sent.push(message);
        },
        close() {
          closed.push("conn_1");
        },
      },
    });

    hub.closeAll();
    expect(hub.size()).toBe(0);
    expect(closed).toEqual(["conn_1"]);
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      type: "stream.error",
      payload: { code: "shutdown" },
    });
  });
});
