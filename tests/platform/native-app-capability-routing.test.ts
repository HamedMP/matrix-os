import { describe, expect, it } from "vitest";
import {
  buildExplicitVmWebSocketUpstreamPath,
  hasExplicitVmNativeAppStreamCapability,
  isNativeAppStreamPath,
  readExplicitVmWebSocketRoute,
} from "../../packages/platform/src/session-routing-identity.js";

describe("native app capability routing", () => {
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
});
