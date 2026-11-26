import { describe, expect, it } from "vitest";
import { resolveBrowserSetupOwner } from "../../packages/gateway/src/browser-lab/setup.js";
import { createGatewayAllowedOriginController } from "../../packages/gateway/src/server/browser-setup-origin.js";
import { resolveWebSocketOriginPolicy } from "../../packages/gateway/src/server/websocket-origin-gate.js";

// Spec 2707: connecting a self-hosted computer (spec 2701) to a Matrix account
// replaces its self-host ids with the platform machine id, Clerk owner and an
// owned-* slot, and the platform forwards the browser's app origin unchanged.
const connected = {
  MATRIX_SELF_HOSTED: "1", MATRIX_SUBSTRATE: "owned", MATRIX_HANDLE: "alice", MATRIX_RUNTIME_SLOT: "owned-0a1b2c3d",
  MATRIX_MACHINE_ID: "4f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f", MATRIX_CLERK_USER_ID: "user_alice", MATRIX_USER_ID: "user_alice",
  MATRIX_ACCESS_MODE: "tailscale", MATRIX_TAILNET_URL: "https://lab.tail1234.ts.net", SHELL_ORIGIN: "https://lab.tail1234.ts.net",
  MATRIX_PUBLIC_APP_URL: "https://app.matrix-os.com",
};

describe("connected self-hosted computer", () => {
  it("keeps Browser setup for the enrolled owner", () => {
    expect(resolveBrowserSetupOwner(connected)).toBe("user_alice");
  });

  it("refuses Browser setup when the enrolled identity is incomplete or mixed with self-host ids", () => {
    for (const overrides of [
      { MATRIX_SUBSTRATE: undefined }, { MATRIX_SUBSTRATE: "vps" }, { MATRIX_RUNTIME_SLOT: "primary" },
      { MATRIX_RUNTIME_SLOT: "owned-../x" }, { MATRIX_USER_ID: "user_other" }, { MATRIX_CLERK_USER_ID: "self-host-alice" },
      { MATRIX_MACHINE_ID: "self-host-alice" }, { MATRIX_SELF_HOSTED: "true" },
    ]) {
      expect(resolveBrowserSetupOwner({ ...connected, ...overrides }), JSON.stringify(overrides)).toBeUndefined();
    }
  });

  it("trusts the platform app origin next to the tailnet origin for browser writes and sockets", () => {
    const controller = createGatewayAllowedOriginController(connected);
    expect(controller.resolve("https://app.matrix-os.com")).toBe("https://app.matrix-os.com");
    expect(controller.resolve("https://lab.tail1234.ts.net")).toBe("https://lab.tail1234.ts.net");
    expect(controller.resolve("https://evil.example.com")).toBeUndefined();
    const policy = resolveWebSocketOriginPolicy(connected, controller);
    expect(policy.enforce).toBe(true);
    expect(policy.isAllowed("https://app.matrix-os.com")).toBe(true);
    expect(policy.isAllowed("https://evil.example.com")).toBe(false);
  });

  it("does not trust the app origin on a computer that is not connected, or from an unsafe setting", () => {
    const standalone = { ...connected, MATRIX_SUBSTRATE: undefined };
    expect(createGatewayAllowedOriginController(standalone).resolve("https://app.matrix-os.com")).toBeUndefined();
    for (const url of ["http://app.matrix-os.com", "https://app.matrix-os.com/path", "https://user@app.matrix-os.com", "not a url"]) {
      expect(createGatewayAllowedOriginController({ ...connected, MATRIX_PUBLIC_APP_URL: url }).resolve("https://app.matrix-os.com"), url)
        .toBeUndefined();
    }
  });
});
