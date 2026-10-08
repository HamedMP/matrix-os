import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGatewayShutdown, shutdownFailure } from "../../packages/gateway/src/process-shutdown.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("gateway shutdown failure log", () => {
  it("names the failing error and its code, never its message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handlers = new Map<string, () => void>();
    const exit = vi.fn();
    registerGatewayShutdown({
      process: { on: (event: string, handler: () => void) => handlers.set(event, handler), off: vi.fn(), exit } as never,
      disposeProcessErrors: vi.fn(),
      closeGateway: async () => {
        throw Object.assign(new Error("connect /home/secret/socket failed"), { code: "ERR_SERVER_NOT_RUNNING" });
      },
      shutdownTelemetry: vi.fn(async () => undefined),
    });
    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(warn).toHaveBeenCalledWith("[gateway] Graceful shutdown failed:", "Error", "ERR_SERVER_NOT_RUNNING");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(shutdownFailure(new TypeError("x"))).toEqual(["TypeError"]);
    expect(shutdownFailure(Object.assign(new Error("x"), { code: "has space" }))).toEqual(["Error"]);
    expect(shutdownFailure("plain")).toEqual(["non-error"]);
  });

  it("closes once on the first signal, exits 0, and lets go of the signals when disposed", async () => {
    const handlers = new Map<string, () => void>();
    const exit = vi.fn();
    const off = vi.fn();
    const closeGateway = vi.fn(async () => undefined);
    const dispose = registerGatewayShutdown({
      process: { on: (event: string, handler: () => void) => handlers.set(event, handler), off, exit } as never,
      disposeProcessErrors: vi.fn(), closeGateway, shutdownTelemetry: vi.fn(async () => undefined),
    });
    handlers.get("SIGINT")!();
    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closeGateway).toHaveBeenCalledTimes(1);
    dispose();
    expect(off.mock.calls.map((call) => call[0])).toEqual(["SIGINT", "SIGTERM"]);
  });
});
