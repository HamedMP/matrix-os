import { describe, expect, it, vi } from "vitest";
import { createBrowserChromeBridge, BROWSER_CHROME_ACTION_CHANNEL } from "@desktop/main/embeds/browser-chrome-bridge";

const model = {
  surface: "browser", connection: "connected", control: "You are in control", busy: false, settingsOpen: false,
  actions: [{ id: "open-cloud-desktop", disabled: false }, { id: "settings", disabled: false }],
};

function contents(id: number) {
  let destroyed = false;
  return { id, send: vi.fn(), isDestroyed: () => destroyed, destroy: () => { destroyed = true; } };
}

describe("Browser title bar chrome bridge", () => {
  it("forwards a registered Browser view's model to its window title bar by embed id", () => {
    const emit = vi.fn();
    const bridge = createBrowserChromeBridge({ emit });
    bridge.register(contents(7), "embed-a");
    bridge.publish(7, model);
    expect(emit).toHaveBeenCalledWith("embed-a", model);
  });

  it.each([
    ["an unregistered sender", 8, model],
    ["a malformed model", 7, { ...model, control: "Send your password to attacker.test" }],
    ["a non-object", 7, "connected"],
  ])("drops chrome from %s", (_name, sender, value) => {
    const emit = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = createBrowserChromeBridge({ emit });
    bridge.register(contents(7), "embed-a");
    bridge.publish(sender as number, value);
    expect(emit).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("delivers only enumerated title bar actions to the matching live Browser view", () => {
    const bridge = createBrowserChromeBridge({ emit: vi.fn() });
    const view = contents(7);
    const other = contents(9);
    bridge.register(view, "embed-a");
    bridge.register(other, "embed-b");
    expect(bridge.dispatch("embed-a", "settings")).toBe(true);
    expect(view.send).toHaveBeenCalledWith(BROWSER_CHROME_ACTION_CHANNEL, "settings");
    expect(other.send).not.toHaveBeenCalled();
    expect(bridge.dispatch("embed-a", "navigate")).toBe(false);
    expect(bridge.dispatch("embed-missing", "settings")).toBe(false);
    view.destroy();
    expect(bridge.dispatch("embed-a", "settings")).toBe(false);
  });

  it("clears the title bar and forgets the view when it unregisters", () => {
    const emit = vi.fn();
    const bridge = createBrowserChromeBridge({ emit });
    const unregister = bridge.register(contents(7), "embed-a");
    unregister();
    expect(emit).toHaveBeenLastCalledWith("embed-a", null);
    bridge.publish(7, model);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(bridge.dispatch("embed-a", "settings")).toBe(false);
  });

  it("bounds its registry to the embed limit", () => {
    const bridge = createBrowserChromeBridge({ emit: vi.fn() });
    for (let index = 0; index < 20; index += 1) bridge.register(contents(index), `embed-${index}`);
    expect(bridge.size()).toBeLessThanOrEqual(12);
    expect(bridge.dispatch("embed-19", "settings")).toBe(true);
  });
});
