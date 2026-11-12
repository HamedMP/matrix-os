// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayAssetUrl, getGatewayUrl, getGatewayWs } from "../../shell/src/lib/gateway";

describe("gateway URL resolution", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    vi.unstubAllEnvs();
  });

  it("uses the bare origin and /ws at the root", () => {
    window.history.replaceState({}, "", "/");
    expect(getGatewayUrl()).toBe(window.location.origin);
    expect(getGatewayWs()).toBe(`ws://${window.location.host}/ws`);
  });

  it("uses an explicit absolute WebSocket origin for composed local stacks", () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_AUTHENTICATE_WS", "1");
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_WS", "ws://127.0.0.1:4117/ws");
    expect(getGatewayWs()).toBe("ws://127.0.0.1:4117/ws");
  });

  it("does not send composed-test WebSocket credentials to a non-loopback origin", () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_AUTHENTICATE_WS", "1");
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_WS", "wss://collector.example.test/ws");
    expect(getGatewayWs()).toBe(`ws://${window.location.host}/ws`);
  });

  it("prefixes API and WS URLs with the explicit /vm/<handle> route", () => {
    window.history.replaceState({}, "", "/vm/pr-1018");
    expect(getGatewayUrl()).toBe(`${window.location.origin}/vm/pr-1018`);
    expect(getGatewayWs()).toBe(`ws://${window.location.host}/vm/pr-1018/ws`);
  });

  it("prefixes nested explicit-vm paths too", () => {
    window.history.replaceState({}, "", "/vm/alice-2/canvas");
    expect(getGatewayUrl()).toBe(`${window.location.origin}/vm/alice-2`);
  });

  it("keeps a runtime selector in the tab-scoped API and WebSocket route", () => {
    window.history.replaceState({}, "", "/vm/alice-shared?runtime=review");
    expect(getGatewayUrl()).toBe(
      `${window.location.origin}/vm/alice-shared/~runtime/review`,
    );
    expect(getGatewayWs()).toBe(
      `ws://${window.location.host}/vm/alice-shared/~runtime/review/ws`,
    );
  });

  it("keeps an explicit runtime path independent of cookies and conflicting query selectors", () => {
    window.history.replaceState({}, "", "/vm/alice-shared/~runtime/alpha/canvas?runtime=beta");
    expect(getGatewayUrl()).toBe(`${window.location.origin}/vm/alice-shared/~runtime/alpha`);
    expect(getGatewayWs()).toBe(`ws://${window.location.host}/vm/alice-shared/~runtime/alpha/ws`);
  });

  it("binds gateway, WebSocket and icon URLs to the current DevStack worktree", () => {
    for (const worktree of ["eng-123", "eng-456"]) {
      const prefix = `/devstack/worktrees/${worktree}`;
      window.history.replaceState({}, "", `${prefix}/?runtime=other`);
      expect(getGatewayUrl()).toBe(`${window.location.origin}${prefix}`);
      expect(getGatewayWs()).toBe(`ws://${window.location.host}${prefix}/ws`);
      expect(gatewayAssetUrl("/icons/app.svg")).toBe(`${window.location.origin}${prefix}/icons/app.svg`);
    }
  });

  it("does not prefix lookalike non-vm paths", () => {
    window.history.replaceState({}, "", "/settings/vmware");
    expect(getGatewayUrl()).toBe(window.location.origin);
  });

  it("reads the browser location directly inside the browser-only helper", () => {
    const source = readFileSync("shell/src/lib/gateway.ts", "utf8");
    expect(source).not.toContain("window.location?.");
  });
});
