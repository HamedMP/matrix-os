import { afterEach, describe, it, expect } from "vitest";
import {
  getWebSocketUpgradeHost,
  getWebSocketUpgradeToken,
  getSessionRoutedWebSocketHost,
  isAppDomainHost,
  isCodeDomainHost,
  isInternalWebSocketOriginHost,
  isSessionRoutedHost,
  isSafeWebSocketUpgradePath,
  stripWebSocketUpgradeToken,
} from "../../packages/platform/src/ws-upgrade.js";

const originalAppDomainHosts = process.env.MATRIX_APP_DOMAIN_HOSTS;
const originalCodeDomainHosts = process.env.MATRIX_CODE_DOMAIN_HOSTS;

afterEach(() => {
  restoreEnv("MATRIX_APP_DOMAIN_HOSTS", originalAppDomainHosts);
  restoreEnv("MATRIX_CODE_DOMAIN_HOSTS", originalCodeDomainHosts);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe("websocket upgrade path helpers", () => {
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
    expect(stripWebSocketUpgradeToken("/ws?runtime=staging&token=abc123&cwd=projects")).toBe("/ws?cwd=projects");
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

  it("accepts explicitly configured staging app-domain hosts", () => {
    process.env.MATRIX_APP_DOMAIN_HOSTS = "staging-app.matrix-os.com";

    expect(isAppDomainHost("staging-app.matrix-os.com")).toBe(true);
    expect(isAppDomainHost("staging-app.matrix-os.com:443")).toBe(true);
    expect(isSessionRoutedHost("staging-app.matrix-os.com")).toBe(true);
  });

  it("ignores malformed configured app-domain hosts", () => {
    process.env.MATRIX_APP_DOMAIN_HOSTS = "https://staging-app.matrix-os.com, staging app";

    expect(isAppDomainHost("staging-app.matrix-os.com")).toBe(false);
  });

  it("accepts app and code domains as session-routed websocket hosts", () => {
    expect(isCodeDomainHost("code.matrix-os.com")).toBe(true);
    expect(isCodeDomainHost("code.localhost:3000")).toBe(true);
    expect(isSessionRoutedHost("app.matrix-os.com")).toBe(true);
    expect(isSessionRoutedHost("code.matrix-os.com")).toBe(true);
    expect(isSessionRoutedHost("legacy.matrix-os.com")).toBe(false);
  });

});

describe("session-routed websocket hosts", () => {
  it("recognizes internal tunnel origin hosts without depending on container names", () => {
    expect(isInternalWebSocketOriginHost("platform:9000")).toBe(true);
    expect(isInternalWebSocketOriginHost("matrix-router:9000")).toBe(true);
    expect(isInternalWebSocketOriginHost("127.0.0.1:9000")).toBe(true);
    expect(isInternalWebSocketOriginHost("evil.matrix-os.com")).toBe(false);
  });

  it("falls back to app domain for token-authenticated tunnel websocket upgrades", () => {
    expect(getSessionRoutedWebSocketHost("platform:9000", undefined, "/ws?token=abc")).toBe("app.matrix-os.com");
    expect(getSessionRoutedWebSocketHost("platform:9000", undefined, "/ws")).toBe("platform:9000");
    expect(getSessionRoutedWebSocketHost("evil.example.com", undefined, "/ws?token=abc")).toBe("evil.example.com");
    expect(getSessionRoutedWebSocketHost("platform:9000", "code.matrix-os.com", "/ws?token=abc")).toBe("code.matrix-os.com");
  });
});
