import { describe, it, expect } from "vitest";
import {
  getWebSocketUpgradeHost,
  getWebSocketUpgradeToken,
  isAppDomainHost,
  isCodeDomainHost,
  isSessionRoutedHost,
  isSafeWebSocketUpgradePath,
  stripWebSocketUpgradeToken,
} from "../../packages/platform/src/ws-upgrade.js";

describe("isSafeWebSocketUpgradePath", () => {
  it("accepts normal websocket paths", () => {
    expect(isSafeWebSocketUpgradePath("/ws")).toBe(true);
    expect(isSafeWebSocketUpgradePath("/ws?token=abc")).toBe(true);
  });

  it("rejects CRLF injection in the request target", () => {
    expect(isSafeWebSocketUpgradePath("/ws\r\nX-Evil: yes")).toBe(false);
    expect(isSafeWebSocketUpgradePath("/ws\nGET /admin HTTP/1.1")).toBe(false);
  });

  it("extracts the websocket query token", () => {
    expect(getWebSocketUpgradeToken("/ws?token=abc123&cwd=projects")).toBe("abc123");
    expect(getWebSocketUpgradeToken("/ws?cwd=projects")).toBeNull();
  });

  it("strips the websocket query token before proxying upstream", () => {
    expect(stripWebSocketUpgradeToken("/ws?token=abc123&cwd=projects")).toBe("/ws?cwd=projects");
    expect(stripWebSocketUpgradeToken("/ws/terminal?token=abc123")).toBe("/ws/terminal");
  });

  it("prefers x-forwarded-host for websocket host resolution", () => {
    expect(getWebSocketUpgradeHost("platform:9000", "app.matrix-os.com")).toBe("app.matrix-os.com");
    expect(getWebSocketUpgradeHost("platform:9000", "app.matrix-os.com, platform:9000")).toBe("app.matrix-os.com");
  });

  it("falls back to host when x-forwarded-host is absent", () => {
    expect(getWebSocketUpgradeHost("app.matrix-os.com", undefined)).toBe("app.matrix-os.com");
  });

  it("accepts only app-domain websocket hosts for shell upgrades", () => {
    expect(isAppDomainHost("app.matrix-os.com")).toBe(true);
    expect(isAppDomainHost("app.localhost:3000")).toBe(true);
    expect(isAppDomainHost("legacy.matrix-os.com")).toBe(false);
    expect(isAppDomainHost("malicious.example.com")).toBe(false);
  });

  it("accepts app and code domains as session-routed websocket hosts", () => {
    expect(isCodeDomainHost("code.matrix-os.com")).toBe(true);
    expect(isCodeDomainHost("code.localhost:3000")).toBe(true);
    expect(isSessionRoutedHost("app.matrix-os.com")).toBe(true);
    expect(isSessionRoutedHost("code.matrix-os.com")).toBe(true);
    expect(isSessionRoutedHost("legacy.matrix-os.com")).toBe(false);
  });
});
