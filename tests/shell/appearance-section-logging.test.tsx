// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  saveThemeMock: vi.fn(),
  saveDesktopConfigMock: vi.fn(),
  setDockMock: vi.fn(),
  config: {
    background: { type: "wallpaper", name: "forest.png" } as const,
    dock: { position: "left", size: 56, iconSize: 40, autoHide: false } as const,
    pinnedApps: [],
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ mode: "dark" }),
  saveTheme: shared.saveThemeMock,
  DEFAULT_THEME: {
    style: "flat",
    colors: { background: "#ffffff" },
  },
}));

vi.mock("@/lib/theme-presets", () => ({
  RETRO_THEME: {
    style: "neumorphic",
    colors: { background: "#d4d4d4" },
  },
}));

vi.mock("@/hooks/useDesktopConfig", () => ({
  useDesktopConfig: () => shared.config,
  saveDesktopConfig: shared.saveDesktopConfigMock,
  buildMeshGradient: () => "linear-gradient(#111111, #222222)",
}));

vi.mock("@/stores/desktop-config", () => ({
  useDesktopConfigStore: (selector: (store: { setDock: typeof shared.setDockMock }) => unknown) => (
    selector({ setDock: shared.setDockMock })
  ),
}));

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: () => null,
}));

import { AppearanceSection } from "../../shell/src/components/settings/sections/AppearanceSection.js";

class FileReaderMock {
  result: string | ArrayBuffer | null = "data:image/png;base64,ZmFrZQ==";
  onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

  readAsDataURL(_file: Blob) {
    this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>);
  }
}

describe("AppearanceSection warning logs", () => {
  beforeEach(() => {
    shared.saveThemeMock.mockReset();
    shared.saveDesktopConfigMock.mockReset();
    shared.setDockMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ wallpapers: ["forest.png"] }),
    })));
    vi.stubGlobal("FileReader", FileReaderMock as unknown as typeof FileReader);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs fetch failures when loading wallpapers", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));

    render(<AppearanceSection />);

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[appearance] Failed to fetch wallpapers:",
        expect.any(Error),
      );
    });
  });

  it("logs upload failures when the wallpaper POST fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ wallpapers: ["forest.png"] }),
      })
      .mockRejectedValueOnce(new Error("upload failed"));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<AppearanceSection />);
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input!, {
      target: {
        files: [new File(["binary"], "forest.png", { type: "image/png" })],
      },
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[appearance] Failed to upload wallpaper:",
        expect.any(Error),
      );
    });
  });

  it("logs delete failures when the wallpaper DELETE fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ wallpapers: ["forest.png"] }),
      })
      .mockRejectedValueOnce(new Error("delete failed"));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<AppearanceSection />);

    await waitFor(() => {
      expect(container.querySelector("button.absolute")).not.toBeNull();
    });

    fireEvent.click(container.querySelector("button.absolute")!);

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[appearance] Failed to delete wallpaper "forest.png":',
        expect.any(Error),
      );
    });
  });
});
