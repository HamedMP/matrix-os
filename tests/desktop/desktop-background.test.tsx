// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  api: null as {
    get: ReturnType<typeof vi.fn>;
    getBlob: ReturnType<typeof vi.fn>;
  } | null,
}));

vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({
  useConnection: (selector: (state: { api: typeof mocks.api }) => unknown) => selector({ api: mocks.api }),
}));

vi.mock("../../desktop/src/renderer/src/stores/ui", () => ({
  useUi: (selector: (state: { desktopBackgroundRefreshRequest: number }) => unknown) => (
    selector({ desktopBackgroundRefreshRequest: 0 })
  ),
}));

import DesktopBackground from "../../desktop/src/renderer/src/features/desktop-shell/DesktopBackground";
import {
  captureDesktopIconsHydrationRevision,
  resetDesktopIconsRuntime,
  useDesktopIcons,
} from "../../desktop/src/renderer/src/stores/desktop-icons";

afterEach(() => {
  cleanup();
  resetDesktopIconsRuntime();
  vi.unstubAllGlobals();
  mocks.api = null;
});

describe("DesktopBackground", () => {
  it("does not replace canonical icon positions with legacy desktop settings", async () => {
    const movedSettingsIcon = { path: "__settings__", x: 640, y: 320 };
    useDesktopIcons.getState().hydrate(
      [movedSettingsIcon],
      [],
      captureDesktopIconsHydrationRevision(),
    );
    mocks.api = {
      get: vi.fn().mockResolvedValue({
        background: { type: "solid", color: "#123456" },
        desktopIcons: [{ path: "__settings__", x: 20, y: 204 }],
      }),
      getBlob: vi.fn(),
    };

    const { getByTestId } = render(<DesktopBackground />);

    await waitFor(() => {
      expect(getByTestId("desktop-background").style.backgroundColor).toBe("rgb(18, 52, 86)");
    });
    expect(useDesktopIcons.getState().icons).toEqual([movedSettingsIcon]);
  });

  it("keeps the current wallpaper visible until a focus refresh downloads its replacement", async () => {
    class LoadedImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    let resolveSecondBlob: ((blob: Blob) => void) | undefined;
    const secondBlob = new Promise<Blob>((resolve) => { resolveSecondBlob = resolve; });
    const createObjectURL = vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    mocks.api = {
      get: vi.fn().mockResolvedValue({ background: { type: "wallpaper", name: "matrix.jpg" } }),
      getBlob: vi.fn().mockResolvedValueOnce(new Blob(["first"])).mockImplementationOnce(() => secondBlob),
    };

    const { getByTestId } = render(<DesktopBackground />);
    await waitFor(() => expect(getByTestId("desktop-background").style.backgroundImage).toContain("blob:first"));

    fireEvent.focus(window);
    await waitFor(() => expect(mocks.api?.getBlob).toHaveBeenCalledTimes(2));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(getByTestId("desktop-background").style.backgroundImage).toContain("blob:first");

    resolveSecondBlob?.(new Blob(["second"]));
    await waitFor(() => expect(getByTestId("desktop-background").style.backgroundImage).toContain("blob:second"));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:first"));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });
});
