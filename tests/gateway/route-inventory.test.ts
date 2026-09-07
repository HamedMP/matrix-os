import { describe, expect, it } from "vitest";
import {
  GATEWAY_ROUTE_GROUPS,
  gatewayRouteGroupForPath,
} from "../../packages/gateway/src/server/route-inventory.js";

describe("gateway route inventory", () => {
  it("keeps oversized server route split targets explicit", () => {
    expect(GATEWAY_ROUTE_GROUPS.map((group) => group.id)).toEqual([
      "middleware",
      "readiness",
      "shell-terminal",
      "app-runtime",
      "websockets",
      "files-workspace",
      "bridge",
      "system",
      "data-features",
    ]);

    expect(new Set(GATEWAY_ROUTE_GROUPS.map((group) => group.plannedModule)).size).toBe(GATEWAY_ROUTE_GROUPS.length);
  });

  it("maps representative routes to their planned modules", () => {
    expect(gatewayRouteGroupForPath("/api/apps/weather/session")?.id).toBe("app-runtime");
    expect(gatewayRouteGroupForPath("/ws/terminal/session")?.id).toBe("shell-terminal");
    expect(gatewayRouteGroupForPath("/api/bridge/data")?.id).toBe("bridge");
    expect(gatewayRouteGroupForPath("/api/canvases/abc")?.id).toBe("data-features");
    expect(gatewayRouteGroupForPath("/files/system/icons/app.png")?.id).toBe("files-workspace");
  });
});
