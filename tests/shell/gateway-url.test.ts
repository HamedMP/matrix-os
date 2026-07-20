// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getGatewayUrl, getGatewayWs } from "../../shell/src/lib/gateway";

describe("gateway URL resolution", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("uses the bare origin and /ws at the root", () => {
    window.history.replaceState({}, "", "/");
    expect(getGatewayUrl()).toBe(window.location.origin);
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

  it("does not prefix lookalike non-vm paths", () => {
    window.history.replaceState({}, "", "/settings/vmware");
    expect(getGatewayUrl()).toBe(window.location.origin);
  });

  it("reads the browser location directly inside the browser-only helper", () => {
    const source = readFileSync("shell/src/lib/gateway.ts", "utf8");
    expect(source).not.toContain("window.location?.");
  });
});
