// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveShortcuts, type ShortcutPlatform } from "@matrix-os/contracts/keyboard-shortcuts";
import type { ShortcutSnapshot } from "@desktop/shared/shortcuts-ipc";

type StoreModule = typeof import("@desktop/renderer/src/stores/shortcuts");

function snapshot(platform: ShortcutPlatform, overrides: Record<string, string[]> = {}): ShortcutSnapshot {
  const document = { version: 1 as const, overrides };
  return { platform, overrides: document, effective: resolveShortcuts(document, platform) };
}

let invoke: ReturnType<typeof vi.fn>;
let listeners: Map<string, Array<(payload: unknown) => void>>;
let store: StoreModule;

function emit(channel: string, payload: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}

beforeEach(async () => {
  listeners = new Map();
  invoke = vi.fn(async (channel: string) => {
    if (channel === "shortcuts:get") return snapshot("mac");
    throw new Error(`unexpected channel ${channel}`);
  });
  vi.stubGlobal("operator", {
    invoke,
    on: (channel: string, callback: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((cb) => cb !== callback));
    },
  });
  vi.resetModules();
  store = await import("@desktop/renderer/src/stores/shortcuts");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useShortcuts", () => {
  it("loads the snapshot and follows later changes through one subscription", async () => {
    await store.useShortcuts.getState().load();
    await store.useShortcuts.getState().load();

    expect(invoke).toHaveBeenCalledWith("shortcuts:get", {});
    expect(listeners.get("shortcuts:changed")).toHaveLength(1);
    expect(store.useShortcuts.getState().snapshot?.effective["nav.palette"]).toEqual(["Cmd+K"]);

    emit("shortcuts:changed", snapshot("mac", { "nav.palette": ["Cmd+Shift+K"] }));

    expect(store.useShortcuts.getState().snapshot?.effective["nav.palette"]).toEqual(["Cmd+Shift+K"]);
  });

  it("keeps a change that arrives while the first read is in flight", async () => {
    let resolveGet: (value: ShortcutSnapshot) => void = () => undefined;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));

    const loading = store.useShortcuts.getState().load();
    emit("shortcuts:changed", snapshot("mac", { "nav.palette": ["Cmd+Shift+K"] }));
    resolveGet(snapshot("mac"));
    await loading;

    expect(store.useShortcuts.getState().snapshot?.effective["nav.palette"]).toEqual(["Cmd+Shift+K"]);
  });

  it("logs a failed read and leaves the snapshot empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockRejectedValueOnce(new Error("bridge down"));

    await store.useShortcuts.getState().load();

    expect(store.useShortcuts.getState().snapshot).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("saves overrides and takes the snapshot main returns", async () => {
    await store.useShortcuts.getState().load();
    const saved = snapshot("mac", { "app.show-desktop": ["Cmd+F3"] });
    invoke.mockResolvedValueOnce(saved);

    const ok = await store.useShortcuts.getState().save(saved.overrides);

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("shortcuts:set", { overrides: saved.overrides });
    expect(store.useShortcuts.getState().snapshot).toEqual(saved);
    expect(store.useShortcuts.getState().error).toBeNull();
  });

  it("keeps the snapshot and reports a generic error when a save is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.useShortcuts.getState().load();
    const before = store.useShortcuts.getState().snapshot;
    invoke.mockRejectedValueOnce(new Error("invalid overrides"));

    const ok = await store.useShortcuts.getState().save({ version: 1, overrides: { "nav.palette": ["Cmd+C"] } });

    expect(ok).toBe(false);
    expect(store.useShortcuts.getState().snapshot).toBe(before);
    expect(store.useShortcuts.getState().error).toBe("Could not save shortcut. Please try again.");
  });

  it("clears an earlier save error after a successful save", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.useShortcuts.getState().load();
    invoke.mockRejectedValueOnce(new Error("invalid overrides"));
    await store.useShortcuts.getState().save({ version: 1, overrides: {} });
    invoke.mockResolvedValueOnce(snapshot("mac"));

    await store.useShortcuts.getState().save({ version: 1, overrides: {} });

    expect(store.useShortcuts.getState().error).toBeNull();
  });
});

describe("shortcutLabel", () => {
  it("hides hints until the bindings have loaded", () => {
    expect(store.shortcutLabel("nav.palette")).toBeNull();
  });

  it("joins mac symbols without a separator", async () => {
    await store.useShortcuts.getState().load();

    expect(store.shortcutLabel("nav.palette")).toBe("⌘K");
    expect(store.shortcutLabel("app.next")).toBe("⌃⇥");
    expect(store.shortcutLabel("terminal.focus")).toBe("⌘⌥T");
  });

  it("joins words with + elsewhere", async () => {
    invoke.mockResolvedValueOnce(snapshot("other"));
    await store.useShortcuts.getState().load();

    expect(store.shortcutLabel("nav.palette")).toBe("Ctrl+K");
    expect(store.shortcutLabel("nav.settings")).toBe("Ctrl+,");
  });

  it("is null for an action with no binding", async () => {
    await store.useShortcuts.getState().load();

    expect(store.shortcutLabel("app.show-desktop")).toBeNull();
  });

  it("follows a rebinding", async () => {
    await store.useShortcuts.getState().load();
    emit("shortcuts:changed", snapshot("mac", { "nav.palette": ["Cmd+Shift+P", "Cmd+K"] }));

    expect(store.shortcutLabel("nav.palette")).toBe("⌘⇧P");
  });
});
