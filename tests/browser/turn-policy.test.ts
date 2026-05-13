import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertBrowserRelayCandidate,
  isBrowserRelayCandidate,
  mintBrowserTurnCredential,
} from "../../packages/gateway/src/turn-credentials.js";

describe("Browser TURN policy", () => {
  it("mints short-lived relay-only TURN credentials", () => {
    const credential = mintBrowserTurnCredential({
      ownerId: "owner_1",
      sessionId: "session_1",
      urls: ["turns:turn.matrix-os.com:5349"],
      secret: "secret",
      now: 1_000,
      ttlSeconds: 300,
    });

    const expected = createHmac("sha1", "secret").update(credential.username).digest("base64");
    expect(credential.username).toMatch(/^301:owner_1:session_1:/);
    expect(credential.credential).toBe(expected);
    expect(credential.expiresAt).toBe(new Date(301_000).toISOString());
    expect(credential.iceTransportPolicy).toBe("relay");
  });

  it("filters non-relay and topology-leaking candidates", () => {
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 93.184.216.34 3478 typ relay")).toBe(true);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 93.184.216.34 3478 typ srflx")).toBe(false);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 192.168.1.10 3478 typ relay")).toBe(false);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 ::ffff:192.168.1.10 3478 typ relay")).toBe(false);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 100.64.0.1 3478 typ relay")).toBe(false);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 224.0.0.1 3478 typ relay")).toBe(false);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 198.51.100.1 3478 typ relay")).toBe(false);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 203.0.113.1 3478 typ relay")).toBe(false);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 198.51.1.1 3478 typ relay")).toBe(true);
    expect(isBrowserRelayCandidate("candidate:1 1 udp 1 203.0.1.1 3478 typ relay")).toBe(true);
    expect(() => assertBrowserRelayCandidate("candidate:1 1 udp 1 fe80::1 3478 typ relay")).toThrow("media_policy");
    expect(() => assertBrowserRelayCandidate("candidate:1 1 udp 1 fe90::1 3478 typ relay")).toThrow("media_policy");
  });
});
