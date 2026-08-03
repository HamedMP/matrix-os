import { describe, expect, it } from "vitest";
import {
  buildExplicitVmWebSocketUpstreamPath,
  hasExplicitVmNativeAppStreamCapability,
  hasExplicitVmT3ProxyCapability,
  isNativeAppStreamPath,
  readExplicitVmWebSocketRoute,
  readExplicitVmRoute,
} from "../../packages/platform/src/session-routing-identity.js";

describe("native app capability routing", () => {
  it("keeps a path-qualified runtime selector out of the upstream path", () => {
    expect(readExplicitVmRoute("/vm/alice-shared/~runtime/review/api/projects")).toEqual({
      handle: "alice-shared",
      runtimeSlot: "review",
      upstreamPath: "/api/projects",
    });
    expect(buildExplicitVmWebSocketUpstreamPath(
      "/vm/alice-shared/~runtime/review/ws?token=secret",
    )).toBe("/ws?token=secret");
  });

  it("maps explicit VM native app WebSocket paths to the selected runtime", () => {
    const path = "/vm/alice-staging/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/";

    const route = readExplicitVmWebSocketRoute(path);
    expect(route).toEqual({
      handle: "alice-staging",
      upstreamPath: "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/",
    });
    expect(hasExplicitVmNativeAppStreamCapability("GET", route!)).toBe(true);
    expect(buildExplicitVmWebSocketUpstreamPath(path)).toBe(
      "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/",
    );
  });

  it("rejects malformed and tokenless native app capability paths", () => {
    expect(hasExplicitVmNativeAppStreamCapability("POST", {
      handle: "alice-staging",
      upstreamPath: "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/",
    })).toBe(false);
    const tokenlessRoute = {
      handle: "alice-staging",
      upstreamPath: "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/js/Utilities.js",
    };
    expect(isNativeAppStreamPath(tokenlessRoute.upstreamPath)).toBe(true);
    expect(hasExplicitVmNativeAppStreamCapability("GET", tokenlessRoute)).toBe(false);
    expect(readExplicitVmWebSocketRoute("/vm/invalid%2Fhandle/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/")).toBeNull();
  });

  it("limits credentialless T3 proxying to its bounded protocol namespace", () => {
    const route = readExplicitVmRoute(
      "/vm/alice/api/integrations/t3/api/auth/websocket-ticket",
    );
    expect(hasExplicitVmT3ProxyCapability("POST", route!)).toBe(true);
    expect(hasExplicitVmT3ProxyCapability("GET", {
      handle: "alice",
      upstreamPath: "/api/integrations/t3/.well-known/t3/environment",
    })).toBe(true);
    expect(hasExplicitVmT3ProxyCapability("CONNECT", route!)).toBe(false);
    expect(hasExplicitVmT3ProxyCapability("GET", {
      handle: "alice",
      upstreamPath: "/api/integrations/t3-evil/api/auth/session",
    })).toBe(false);
    expect(hasExplicitVmT3ProxyCapability("GET", {
      handle: "alice",
      upstreamPath: "/api/integrations/t3/%2e%2e/health",
    })).toBe(false);
  });
});
