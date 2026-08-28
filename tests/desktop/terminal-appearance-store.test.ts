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

  it("defaults the shell palette to Matrix OS Dark before persisted state hydrates", () => {
    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "matrix-dark", hydrated: false });
  });

  it("loads a saved shell palette without changing the global Desktop appearance", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: { themeId: "powerlevel10k-rainbow" } };
      return { ok: true };
    });

    await useTerminalAppearance.getState().load();

    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "powerlevel10k-rainbow", hydrated: true });
    expect(window.operator.invoke).toHaveBeenCalledWith("state:get", { key: "terminalAppearance" });
  });

  it("migrates the old app-chrome preference into the equivalent shell palette", async () => {
    window.operator.invoke = vi.fn(async () => ({ value: { appThemeId: "matrix" } }));

    await useTerminalAppearance.getState().load();

    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "matrix", hydrated: true });
  });

  it("preserves a newer explicit selection when startup hydration resolves late", async () => {
    let resolveLoad: ((value: { value: { mode: "dark" } }) => void) | undefined;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return new Promise<{ value: { mode: "dark" } }>((resolve) => {
          resolveLoad = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    });

    const load = useTerminalAppearance.getState().load();
    useTerminalAppearance.getState().setThemeId("powerlevel10k-pure");
    resolveLoad?.({ value: { mode: "dark" } });
    await load;

    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "powerlevel10k-pure", hydrated: true });
  });

  it("persists an explicit shell palette change", () => {
    useTerminalAppearance.getState().setThemeId("dracula");

    expect(useTerminalAppearance.getState().themeId).toBe("dracula");
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: "terminalAppearance",
      value: { themeId: "dracula" },
    });
  });
});
