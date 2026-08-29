// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalAppearance } from "@desktop/renderer/src/stores/terminal-appearance";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";

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
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
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

  it("reconciles a failed palette write with the authoritative saved preference", async () => {
    const api = createApi("dark");
    api.put = vi.fn().mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      useTerminalAppearance.getState().setThemeId("matrix", api);
      expect(useTerminalAppearance.getState().themeId).toBe("matrix");

      await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/terminal/preferences"));
      await vi.waitFor(() => expect(useTerminalAppearance.getState().themeId).toBe("dark"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not reconcile an older failed write over a newer palette selection", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const api = createApi("dark");
    api.put = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValue({ preferences: { shellThemeId: "powerlevel10k-pure" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      useTerminalAppearance.getState().setThemeId("powerlevel10k-classic", api);
      await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      useTerminalAppearance.getState().setThemeId("powerlevel10k-pure", api);

      rejectFirst?.(new Error("offline"));
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/terminal/preferences"));
      await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));

      expect(useTerminalAppearance.getState().themeId).toBe("powerlevel10k-pure");
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to the last confirmed palette when failed writes cannot reload", async () => {
    const api = createApi("dark");
    api.put = vi.fn().mockRejectedValue(new Error("offline"));
    api.get = vi.fn().mockRejectedValue(new Error("still offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      useTerminalAppearance.getState().setThemeId("powerlevel10k-classic", api);
      useTerminalAppearance.getState().setThemeId("powerlevel10k-pure", api);

      await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(useTerminalAppearance.getState().themeId).toBe("dark"));
    } finally {
      warn.mockRestore();
    }
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

  it("waits for pending palette writes before hydrating a replacement ApiClient", async () => {
    let persistedTheme = "dark";
    let resolveWrite: (() => void) | undefined;
    const firstApi = createApi();
    firstApi.put = vi.fn(() => new Promise<void>((resolve) => {
      resolveWrite = () => {
        persistedTheme = "matrix";
        resolve();
      };
    }));
    const replacementApi = createApi();
    replacementApi.get = vi.fn(async () => ({
      preferences: { shellThemeId: persistedTheme },
    }));

    useTerminalAppearance.getState().setThemeId("matrix", firstApi);
    const load = useTerminalAppearance.getState().load(replacementApi);

    await Promise.resolve();
    expect(firstApi.put).toHaveBeenCalledTimes(1);
    expect(replacementApi.get).not.toHaveBeenCalled();

    resolveWrite?.();
    await load;

    expect(replacementApi.get).toHaveBeenCalledWith("/api/terminal/preferences");
    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "matrix", hydrated: true });
  });

  it("drops a queued palette write after the runtime generation changes", async () => {
    let resolveFirst: (() => void) | undefined;
    const previousApi = createApi();
    previousApi.put = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValue({ preferences: { shellThemeId: "powerlevel10k-pure" } });
    const replacementApi = createApi("matrix");

    useTerminalAppearance.getState().setThemeId("powerlevel10k-classic", previousApi);
    useTerminalAppearance.getState().setThemeId("powerlevel10k-pure", previousApi);
    await Promise.resolve();
    expect(previousApi.put).toHaveBeenCalledTimes(1);

    advanceRuntimeGeneration();
    const load = useTerminalAppearance.getState().load(replacementApi);
    resolveFirst?.();
    await load;

    expect(previousApi.put).toHaveBeenCalledTimes(1);
    expect(replacementApi.get).toHaveBeenCalledWith("/api/terminal/preferences");
    expect(useTerminalAppearance.getState()).toMatchObject({ themeId: "matrix", hydrated: true });
  });
});
