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

  it("persists a supported shell palette through global terminal preferences", async () => {
    const api = createApi();
    useTerminalAppearance.getState().setThemeId("powerlevel10k-classic", api);

    expect(useTerminalAppearance.getState().themeId).toBe("powerlevel10k-classic");
    await vi.waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/api/terminal/preferences", {
        shellThemeId: "powerlevel10k-classic",
      });
    });
  });

  it("ignores a shell palette selection while the runtime API is unavailable", () => {
    useTerminalAppearance.getState().setThemeId("matrix", null);

    expect(useTerminalAppearance.getState()).toMatchObject({
      themeId: "dark",
      selectionRevision: 0,
    });
  });

  it("serializes rapid shell palette writes in selection order", async () => {
    let resolveFirst: (() => void) | undefined;
    const api = createApi();
    api.put = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValue({ preferences: { shellThemeId: "powerlevel10k-pure" } });

    useTerminalAppearance.getState().setThemeId("powerlevel10k-classic", api);
    useTerminalAppearance.getState().setThemeId("powerlevel10k-pure", api);

    await Promise.resolve();
    expect(api.put).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put.mock.calls.map(([, body]) => body)).toEqual([
      { shellThemeId: "powerlevel10k-classic" },
      { shellThemeId: "powerlevel10k-pure" },
    ]);
  });

  it("keeps shell palette writes ordered across ApiClient replacement", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstApi = createApi();
    firstApi.put = vi.fn(() => new Promise<void>((resolve) => {
      resolveFirst = resolve;
    }));
    const replacementApi = createApi();

    useTerminalAppearance.getState().setThemeId("matrix", firstApi);
    useTerminalAppearance.getState().setThemeId("powerlevel10k-rainbow", replacementApi);

    await Promise.resolve();
    expect(firstApi.put).toHaveBeenCalledTimes(1);
    expect(replacementApi.put).not.toHaveBeenCalled();
    resolveFirst?.();
    await vi.waitFor(() => expect(replacementApi.put).toHaveBeenCalledWith(
      "/api/terminal/preferences",
      { shellThemeId: "powerlevel10k-rainbow" },
    ));
  });
});
