import { describe, expect, it } from "vitest";
import { shouldInjectAuth } from "@desktop/main/auth/header-injection";

const GATEWAY = "https://app.matrix-os.com";

describe("shouldInjectAuth", () => {
  it("injects for exact-origin https requests", () => {
    expect(shouldInjectAuth("https://app.matrix-os.com/api/workspace/projects", GATEWAY)).toBe(true);
    expect(shouldInjectAuth("https://app.matrix-os.com/ws?x=1", GATEWAY)).toBe(true);
  });

  it("injects for websocket upgrades to the same host", () => {
    expect(shouldInjectAuth("wss://app.matrix-os.com/ws/terminal/session?session=x", GATEWAY)).toBe(true);
  });

  it("never injects for other origins", () => {
    expect(shouldInjectAuth("https://evil.example.com/api", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://matrix-os.com/", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://app.matrix-os.com.attacker.tld/api", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://sub.app.matrix-os.com/api", GATEWAY)).toBe(false);
  });

  it("never downgrades to plain http for a https gateway", () => {
    expect(shouldInjectAuth("http://app.matrix-os.com/api", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("ws://app.matrix-os.com/ws", GATEWAY)).toBe(false);
  });

  it("supports http+ws for localhost dev gateways", () => {
    const dev = "http://localhost:18789";
    expect(shouldInjectAuth("http://localhost:18789/api/apps", dev)).toBe(true);
    expect(shouldInjectAuth("ws://localhost:18789/ws", dev)).toBe(true);
    expect(shouldInjectAuth("http://localhost:9999/api", dev)).toBe(false);
  });

  it("handles ports strictly", () => {
    expect(shouldInjectAuth("https://app.matrix-os.com:8443/api", GATEWAY)).toBe(false);
  });

  it("rejects garbage urls and null origins", () => {
    expect(shouldInjectAuth("not a url", GATEWAY)).toBe(false);
    expect(shouldInjectAuth("https://app.matrix-os.com/api", null)).toBe(false);
  });
});
