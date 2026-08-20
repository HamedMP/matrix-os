// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalAppearance } from "@desktop/renderer/src/stores/terminal-appearance";

describe("Terminal appearance store", () => {
  beforeEach(() => {
    useTerminalAppearance.setState(useTerminalAppearance.getInitialState(), true);
    window.operator = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "state:get") return { value: null };
        return { ok: true };
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  it("defaults Terminal to dark before persisted state hydrates", () => {
    expect(useTerminalAppearance.getState()).toMatchObject({ mode: "dark", hydrated: false });
  });

  it("loads a saved light preference without reading the global Desktop appearance", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: { mode: "light" } };
      return { ok: true };
    });

    await useTerminalAppearance.getState().load();

    expect(useTerminalAppearance.getState()).toMatchObject({ mode: "light", hydrated: true });
    expect(window.operator.invoke).toHaveBeenCalledWith("state:get", { key: "terminalAppearance" });
  });

  it("falls back to dark when persisted state is absent or invalid", async () => {
    window.operator.invoke = vi.fn(async () => ({ value: { mode: "system" } }));

    await useTerminalAppearance.getState().load();

    expect(useTerminalAppearance.getState()).toMatchObject({ mode: "dark", hydrated: true });
  });

  it("persists an explicit Terminal-only mode change", () => {
    useTerminalAppearance.getState().setMode("light");

    expect(useTerminalAppearance.getState().mode).toBe("light");
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: "terminalAppearance",
      value: { mode: "light" },
    });
  });
});
