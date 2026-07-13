import { describe, expect, it } from "vitest";
import {
  buildShellRuntimeSlotCookie,
  buildExplicitVmWebSocketUpstreamPath,
  hasExplicitVmNativeAppStreamCapability,
  isNativeAppStreamPath,
  readExplicitVmWebSocketRoute,
  resolveExplicitVmRuntimeSlot,
} from "../../packages/platform/src/session-routing-identity.js";

describe("native app capability routing", () => {
  it("allows the routing-slot cookie in opaque native-app iframes", () => {
    expect(buildShellRuntimeSlotCookie("review")).toContain("SameSite=None");
    expect(buildShellRuntimeSlotCookie("review")).toContain("Secure");
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

  it("keeps explicit VM capability traffic on the query or cookie selected runtime", () => {
    const upstreamPath = "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/";

    expect(resolveExplicitVmRuntimeSlot(
      "https://app.matrix-os.com/vm/alice/api/native-apps/xterm/sessions?runtime=review",
      "/api/native-apps/xterm/sessions",
      undefined,
    )).toBe("review");
    expect(resolveExplicitVmRuntimeSlot(
      `https://app.matrix-os.com/vm/alice${upstreamPath}js/Utilities.js`,
      `${upstreamPath}js/Utilities.js`,
      "matrix_shell_runtime_slot=review",
    )).toBe("review");
    expect(resolveExplicitVmRuntimeSlot(
      `https://app.matrix-os.com/vm/alice${upstreamPath}websocket`,
      `${upstreamPath}websocket`,
      "matrix_shell_runtime_slot=review",
    )).toBe("review");
  });
});
