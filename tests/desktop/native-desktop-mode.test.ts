// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";

describe("native desktop mode store", () => {
  beforeEach(() => {
    useNativeDesktopMode.setState(useNativeDesktopMode.getInitialState(), true);
    window.operator = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "state:get") return { value: { mode: "canvas" } };
        return { ok: true };
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  it("migrates persisted Canvas mode to Desktop", async () => {
    await useNativeDesktopMode.getState().load();

    expect(useNativeDesktopMode.getState()).toMatchObject({ mode: "desktop", hydrated: true });
    expect(window.operator.invoke).toHaveBeenCalledWith("state:get", { key: "desktopShell" });
    await vi.waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
        key: "desktopShell",
        value: { mode: "desktop" },
      });
    });
  });

  it("falls back to Desktop for invalid persisted state", async () => {
    window.operator.invoke = vi.fn(async () => ({ value: { mode: "ambient" } }));

    await useNativeDesktopMode.getState().load();

    expect(useNativeDesktopMode.getState()).toMatchObject({ mode: "desktop", hydrated: true });
  });

  it("prevents legacy Canvas selections from replacing Desktop mode", async () => {
    useNativeDesktopMode.getState().setCanvasTransform({ panX: 42, panY: -18, zoom: 1.25 });

    useNativeDesktopMode.getState().setMode("canvas");

    expect(useNativeDesktopMode.getState()).toMatchObject({
      mode: "desktop",
      panX: 42,
      panY: -18,
      zoom: 1.25,
    });
  });

  it("bounds Canvas zoom and resets the spatial view", () => {
    useNativeDesktopMode.getState().setCanvasTransform({ panX: 120, panY: 80, zoom: 9 });
    expect(useNativeDesktopMode.getState().zoom).toBe(2);

    useNativeDesktopMode.getState().resetCanvasTransform();

    expect(useNativeDesktopMode.getState()).toMatchObject({ panX: 0, panY: 0, zoom: 1 });
  });

  it("does not restore Canvas when hydration finishes after a legacy selection", async () => {
    let resolveLoad: ((value: { value: { mode: "desktop" } }) => void) | undefined;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "state:get") {
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    });

    const loading = useNativeDesktopMode.getState().load();
    useNativeDesktopMode.getState().setMode("canvas");
    resolveLoad?.({ value: { mode: "desktop" } });
    await loading;

    expect(useNativeDesktopMode.getState()).toMatchObject({ mode: "desktop", hydrated: true });
  });
});
