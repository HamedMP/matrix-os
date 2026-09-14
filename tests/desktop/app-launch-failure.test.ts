import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedService } from "@desktop/main/embeds/embed-service";

vi.mock("electron", () => ({ net: { request: vi.fn() }, session: { fromPartition: vi.fn() } }));

describe("app launch failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [401, "{}", "auth-required"],
    [403, '{"error":"install_blocked_by_policy"}', "failed"],
    [409, '{"error":"install_gated"}', "failed"],
    [404, '{"error":"not found"}', "failed"],
    [503, '{"error":"internal"}', "failed"],
    [200, "not json", "failed"],
    [200, "{}", "failed"],
  ])("maps HTTP %s with body %s to %s", async (status, body, state) => {
    const emitState = vi.fn();
    const service = new EmbedService({
      getWindow: () => null, getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token", emitState,
    });
    const internals = service as unknown as {
      gatewayRequest: () => Promise<{ status: number; body: string; setCookieHeaders: string[] }>;
      manager: { open: () => string };
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(internals, "gatewayRequest").mockResolvedValue({ status, body, setCookieHeaders: [] });
    const open = vi.spyOn(internals.manager, "open");
    const result = await service.open({ kind: "app", slug: "spec-reader", bounds: { x: 0, y: 0, width: 800, height: 600 } });
    expect(result.state).toBe(state);
    expect(open).not.toHaveBeenCalled();
    await expect(service.retryAuth(result.embedId)).resolves.toBe(false);
    expect(emitState).toHaveBeenLastCalledWith(result.embedId, state);
    service.closeAll();
  });
});
