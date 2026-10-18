// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGatewayUrl, getGatewayWs } from "../../shell/src/lib/gateway";
import { isSharedWorkspacePath, sharedRuntimePresentation } from "../../shell/src/lib/shared-workspace";

afterEach(() => { window.history.replaceState({}, "", "/"); vi.unstubAllEnvs(); });

describe("shared workspace routing", () => {
  it("scopes API and WebSocket requests to the shared workspace, including with local WS configured", () => {
    window.history.replaceState({}, "", "/workspace");
    vi.stubEnv("NEXT_PUBLIC_E2E_AUTHENTICATE_WS", "1");
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_WS", "ws://localhost:4117/ws");
    expect(getGatewayUrl()).toBe(`${window.location.origin}/__shared-workspace`);
    expect(getGatewayWs()).toBe(`ws://${window.location.host}/__shared-workspace/ws`);
  });
  it("preserves personal VPS routing", () => {
    window.history.replaceState({}, "", "/vm/alice?runtime=review");
    expect(getGatewayUrl()).toBe(`${window.location.origin}/vm/alice/~runtime/review`);
    expect(getGatewayWs()).toBe(`ws://${window.location.host}/vm/alice/~runtime/review/ws`);
  });
  it("does not match lookalike routes", () => {
    expect(isSharedWorkspacePath("/workspace-other")).toBe(false);
    expect(isSharedWorkspacePath("/__shared-workspace-other/api/files")).toBe(false);
    expect(isSharedWorkspacePath("/workspace")).toBe(true);
    expect(isSharedWorkspacePath("/__shared-workspace/api/files")).toBe(true);
  });
  it("uses bounded safe status copy and fails closed for unknown states", () => {
    expect(sharedRuntimePresentation("interrupting").message).toContain("Stopping");
    expect(sharedRuntimePresentation("starting").message).toContain("starting");
    expect(sharedRuntimePresentation("failed").retry).toBe(true);
    expect(sharedRuntimePresentation("Cloudflare secret /private/key").message).toBe("Compute is unavailable. Your saved workspace remains accessible.");
  });
});
