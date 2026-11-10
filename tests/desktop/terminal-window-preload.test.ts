import { describe, expect, it, vi } from "vitest";
import { createOperatorBridge } from "@desktop/shared/operator-bridge";
import { TERMINAL_WINDOW_EVENT_CHANNELS, TERMINAL_WINDOW_INVOKE_CHANNELS } from "@desktop/shared/terminal-window";

function setup(role: "main" | "terminal") {
  const ipc = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
  return { ipc, bridge: createOperatorBridge(ipc, role) };
}

describe("operator preload bridge", () => {
  it("exposes only the Terminal window allowlist to the Terminal window", async () => {
    const { ipc, bridge } = setup("terminal");
    await expect(bridge.invoke("auth:sign-out", {})).rejects.toThrow("unknown channel");
    await expect(bridge.invoke("terminal-window:open", {})).rejects.toThrow("unknown channel");
    await expect(bridge.invoke("runtime:select", { slot: "primary" })).rejects.toThrow("unknown channel");
    expect(ipc.invoke).not.toHaveBeenCalled();
    for (const channel of TERMINAL_WINDOW_INVOKE_CHANNELS.filter((name) => name !== "state:get")) {
      await bridge.invoke(channel, {}).catch(() => undefined);
    }
    expect(ipc.invoke).toHaveBeenCalledWith("auth:status", {});
    expect(ipc.invoke).toHaveBeenCalledWith("terminal-window:focus-main", {});
  });

  it("subscribes the Terminal window only to its event allowlist", () => {
    const { ipc, bridge } = setup("terminal");
    bridge.on("runtime:changed", () => undefined);
    bridge.on("embed:state", () => undefined);
    expect(ipc.on).not.toHaveBeenCalled();
    const off = bridge.on("auth:changed", () => undefined);
    expect(ipc.on).toHaveBeenCalledTimes(1);
    off();
    expect(ipc.removeListener).toHaveBeenCalledTimes(1);
    expect(TERMINAL_WINDOW_EVENT_CHANNELS).toContain("auth:changed");
  });

  it("keeps the main window off Terminal-window-only channels and validates payloads", async () => {
    const { ipc, bridge } = setup("main");
    await expect(bridge.invoke("terminal-window:focus-main", {})).rejects.toThrow("unknown channel");
    await expect(bridge.invoke("runtime:select", { slot: 7 })).rejects.toThrow("invalid request");
    await bridge.invoke("terminal-window:open", {});
    expect(ipc.invoke).toHaveBeenCalledWith("terminal-window:open", {});
  });

  it("drops event payloads that fail the contract", () => {
    const { ipc, bridge } = setup("terminal");
    const callback = vi.fn();
    bridge.on("auth:changed", callback);
    const listener = ipc.on.mock.calls[0]![1] as (event: unknown, payload: unknown) => void;
    listener({}, { signedIn: "yes" });
    expect(callback).not.toHaveBeenCalled();
    listener({}, { signedIn: false });
    expect(callback).toHaveBeenCalledWith({ signedIn: false });
  });
});
