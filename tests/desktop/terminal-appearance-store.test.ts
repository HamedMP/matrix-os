// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalAppearance } from "@desktop/renderer/src/stores/terminal-appearance";

function createApi(shellThemeId = "dark") {
  return {
    get: vi.fn(async () => ({ preferences: { shellThemeId } })),
    put: vi.fn(async () => ({ preferences: { shellThemeId } })),
  };
}

describe("Terminal appearance store", () => {
  beforeEach(() => {
    useTerminalAppearance.setState(useTerminalAppearance.getInitialState(), true);
  });

  it("defaults the shell palette to Matrix OS Dark before persisted state hydrates", () => {
    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "dark", hydrated: false });
  });

  it("loads the shared global shell palette without changing Desktop appearance", async () => {
    const api = createApi("powerlevel10k-rainbow");

    await useTerminalAppearance.getState().load(api);

    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "powerlevel10k-rainbow", hydrated: true });
    expect(api.get).toHaveBeenCalledWith("/api/terminal/preferences");
  });

  it("preserves a newer explicit selection when startup hydration resolves late", async () => {
    let resolveLoad: ((value: { preferences: { shellThemeId: string } }) => void) | undefined;
    const api = createApi();
    api.get = vi.fn(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));

    const load = useTerminalAppearance.getState().load(api);
    useTerminalAppearance.getState().setThemeId("powerlevel10k-pure", api);
    resolveLoad?.({ preferences: { shellThemeId: "matrix" } });
    await load;

    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "powerlevel10k-pure", hydrated: true });
  });

  it("persists a supported shell palette through global terminal preferences", () => {
    const api = createApi();
    useTerminalAppearance.getState().setThemeId("powerlevel10k-classic", api);

    expect(useTerminalAppearance.getState().themeId).toBe("powerlevel10k-classic");
    expect(api.put).toHaveBeenCalledWith("/api/terminal/preferences", {
      shellThemeId: "powerlevel10k-classic",
    });
  });
});
