import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_MEDIA_BUDGET,
  assertRelayIceCandidate,
  createBrowserMediaOffer,
  createEphemeralTurnCredential,
  createFallbackFrameQueue,
} from "../../packages/mcp-browser/src/media-service.js";

describe("Browser media plane", () => {
  it("publishes a server WebRTC offer with relay-only ICE policy", () => {
    const offer = createBrowserMediaOffer({
      sdp: "v=0\r\n",
      turn: {
        urls: ["turns:turn.matrix-os.com:5349"],
        username: "u",
        credential: "p",
        expiresAt: new Date(1_000).toISOString(),
      },
    });

    expect(offer).toEqual({
      type: "media.offer",
      payload: {
        sdp: "v=0\r\n",
        iceServers: [{ urls: ["turns:turn.matrix-os.com:5349"], username: "u", credential: "p" }],
        iceTransportPolicy: "relay",
      },
    });
  });

  it("caps fallback frames with a latest-frame queue", () => {
    const queue = createFallbackFrameQueue<number>(3);
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.push(4);
    expect(queue.values()).toEqual([2, 3, 4]);
  });

  it("uses a muted-by-default audio budget", () => {
    expect(DEFAULT_BROWSER_MEDIA_BUDGET).toMatchObject({
      maxWidth: 1280,
      maxHeight: 720,
      maxFrameRate: 30,
      audio: true,
      muted: true,
    });
  });

  it("creates short-lived owner and session bound TURN credentials", () => {
    const credential = createEphemeralTurnCredential({
      ownerId: "owner_1",
      sessionId: "session_1",
      urls: ["turns:turn.matrix-os.com:5349"],
      secret: "credential",
      now: 1_000,
      ttlMs: 300_000,
    });

    expect(credential.username).toContain(":owner_1:session_1:");
    expect(credential.credential).not.toBe("credential");
    expect(credential.credential.length).toBeGreaterThan(0);
    expect(credential.expiresAt).toBe(new Date(301_000).toISOString());
  });

  it("requires an explicit TURN secret", () => {
    expect(() => createEphemeralTurnCredential({
      ownerId: "owner_1",
      sessionId: "session_1",
      urls: ["turns:turn.matrix-os.com:5349"],
      secret: "",
    })).toThrow("turn_secret_required");
  });

  it("accepts relay candidates and rejects host/private candidates", () => {
    expect(() => assertRelayIceCandidate("candidate:1 1 udp 1 93.184.216.34 3478 typ relay")).not.toThrow();
    expect(() => assertRelayIceCandidate("candidate:1 1 udp 1 10.0.0.4 5353 typ host")).toThrow("media_policy");
    expect(() => assertRelayIceCandidate("candidate:1 1 udp 1 10.0.0.4 3478 typ relay")).toThrow("media_policy");
    expect(() => assertRelayIceCandidate("candidate:1 1 udp 1 ::ffff:192.168.1.1 3478 typ relay")).toThrow("media_policy");
    expect(() => assertRelayIceCandidate("candidate:1 1 udp 1 fe90::1 3478 typ relay")).toThrow("media_policy");
  });
});
