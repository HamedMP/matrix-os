import { describe, expect, it, vi } from "vitest";
import { INVOKE_CHANNELS } from "@desktop/shared/ipc-contract";
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
    // Every channel outside the allowlist is refused in the preload itself.
    const allowed = new Set<string>(TERMINAL_WINDOW_INVOKE_CHANNELS);
    for (const channel of Object.keys(INVOKE_CHANNELS).filter((name) => !allowed.has(name))) {
      await expect(bridge.invoke(channel, {}), channel).rejects.toThrow("unknown channel");
    }
    // Saved state is readable only for the appearance key.
    await expect(bridge.invoke("state:get", { key: "recents" })).rejects.toThrow("unknown channel");
    expect(ipc.invoke).not.toHaveBeenCalled();
    await bridge.invoke("state:get", { key: "appearance" });
    expect(ipc.invoke.mock.calls).toEqual([["state:get", { key: "appearance" }]]);
    ipc.invoke.mockClear();
    await bridge.invoke("auth:status", {});
    await bridge.invoke("terminal-window:focus-main", {});
    await bridge.invoke("local-terminal:kill", { id: "t1" });
    expect(ipc.invoke.mock.calls).toEqual([["auth:status", {}], ["terminal-window:focus-main", {}], ["local-terminal:kill", { id: "t1" }]]);
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
