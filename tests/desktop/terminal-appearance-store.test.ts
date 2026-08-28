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

  it("defaults Terminal chrome to Matrix OS Dark before persisted state hydrates", () => {
    expect(useTerminalAppearance.getState()).toMatchObject({ appThemeId: "matrix-dark", hydrated: false });
  });

  it("loads a saved light preference without reading the global Desktop appearance", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: { mode: "light" } };
      return { ok: true };
    });

    await useTerminalAppearance.getState().load();

    expect(useTerminalAppearance.getState()).toMatchObject({ appThemeId: "light", hydrated: true });
    expect(window.operator.invoke).toHaveBeenCalledWith("state:get", { key: "terminalAppearance" });
  });

  it("falls back to Matrix OS Dark when persisted state is absent or invalid", async () => {
    window.operator.invoke = vi.fn(async () => ({ value: { mode: "system" } }));

    await useTerminalAppearance.getState().load();

    expect(useTerminalAppearance.getState()).toMatchObject({ appThemeId: "matrix-dark", hydrated: true });
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
    useTerminalAppearance.getState().setAppThemeId("light");
    resolveLoad?.({ value: { mode: "dark" } });
    await load;

    expect(useTerminalAppearance.getState()).toMatchObject({ appThemeId: "light", hydrated: true });
  });

  it("persists an explicit Terminal-only app theme change", () => {
    useTerminalAppearance.getState().setAppThemeId("matrix");

    expect(useTerminalAppearance.getState().appThemeId).toBe("matrix");
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: "terminalAppearance",
      value: { appThemeId: "matrix" },
    });
  });
});
