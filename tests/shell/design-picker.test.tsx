// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  saveThemeMock: vi.fn(),
  saveDesktopConfigPatchMock: vi.fn(),
  beginBootMock: vi.fn(),
  theme: {
    name: "default",
    style: "flat",
    colors: {},
    fonts: {},
    radius: "0.75rem",
  } as { name: string; style?: string; colors: Record<string, string>; fonts: Record<string, string>; radius: string },
  desktopConfig: {
    background: { type: "wallpaper", name: "moraine-lake.jpg" },
    dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
    pinnedApps: [],
  } as {
    background: { type: string; name: string };
    dock: { position: string; size: number; iconSize: number; autoHide: boolean };
    pinnedApps: string[];
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => shared.theme,
  saveTheme: shared.saveThemeMock,
  DEFAULT_THEME: { name: "default", colors: {}, fonts: {}, radius: "0.75rem" },
}));

vi.mock("@/hooks/useDesktopConfig", () => ({
  useDesktopConfig: () => shared.desktopConfig,
  saveDesktopConfigPatch: shared.saveDesktopConfigPatchMock,
}));

vi.mock("@/components/os-session/os-session-store", () => ({
  useOsSessionStore: {
    getState: () => ({ beginBoot: shared.beginBootMock }),
  },
}));

import { DesignPicker } from "../../shell/src/components/settings/DesignPicker.js";
import {
  MACOS_GLASS_THEME,
  WIN11_THEME,
  WINXP_THEME,
} from "../../shell/src/lib/theme-presets.js";

const DESIGN_LABELS = ["Default", "macOS 27", "Windows XP", "Windows 11"] as const;

function resetTheme(style?: string) {
  shared.theme = { name: "default", colors: {}, fonts: {}, radius: "0.75rem" };
  if (style) shared.theme.style = style;
}

describe("DesignPicker", () => {
  beforeEach(() => {
    shared.saveThemeMock.mockReset();
    shared.saveThemeMock.mockResolvedValue(undefined);
    shared.saveDesktopConfigPatchMock.mockReset();
    shared.saveDesktopConfigPatchMock.mockResolvedValue(undefined);
    shared.beginBootMock.mockReset();
    resetTheme("flat");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all four design options", () => {
    const { getByRole, getAllByRole, queryByRole } = render(<DesignPicker />);

    expect(getByRole("heading", { name: "Design" })).toBeTruthy();
    expect(getAllByRole("button")).toHaveLength(4);
    for (const label of DESIGN_LABELS) {
      expect(getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it("does not offer the retired Retro (neumorphic) design", () => {
    const { queryByRole } = render(<DesignPicker />);

    expect(queryByRole("button", { name: /Retro/ })).toBeNull();
  });

  it("keeps rendering for an existing neumorphic theme with no option selected", () => {
    resetTheme("neumorphic");
    const { getAllByRole } = render(<DesignPicker />);

    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("marks the active design from theme.style", () => {
    resetTheme("winxp");
    const { getByRole } = render(<DesignPicker />);

    expect(getByRole("button", { name: /Windows XP/ }).getAttribute("aria-pressed")).toBe("true");
    for (const label of ["Default", "macOS 27", "Windows 11"]) {
      expect(getByRole("button", { name: new RegExp(label) }).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("treats a missing theme.style as the Default (flat) design", () => {
    resetTheme();
    const { getByRole } = render(<DesignPicker />);

    expect(getByRole("button", { name: /Default/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("saves the matching preset when a design is selected", async () => {
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Windows XP/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(1));
    expect(shared.saveThemeMock).toHaveBeenCalledWith({ ...WINXP_THEME });

    fireEvent.click(getByRole("button", { name: /macOS 27/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(2));
    expect(shared.saveThemeMock).toHaveBeenLastCalledWith({ ...MACOS_GLASS_THEME });

    fireEvent.click(getByRole("button", { name: /Windows 11/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(3));
    expect(shared.saveThemeMock).toHaveBeenLastCalledWith({ ...WIN11_THEME });
  });

  it("starts an OS boot beat only after an explicit design selection", async () => {
    const { getByRole } = render(<DesignPicker />);
    expect(shared.beginBootMock).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: /Windows XP/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(1));
    expect(shared.beginBootMock).toHaveBeenCalledWith("winxp");
  });

  it("saves the flat default preset when Default is selected", async () => {
    resetTheme("win11");
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Default/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(1));
    expect(shared.saveThemeMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "default", style: "flat" }),
    );
  });

  it("shows a generic error when saving fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    shared.saveThemeMock.mockRejectedValueOnce(new Error("Failed to save theme"));
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Default/ }));

    await waitFor(() => {
      const alert = getByRole("alert");
      expect(alert.textContent).toContain("try again");
      expect(alert.textContent).not.toContain("Failed to save theme");
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[appearance] Failed to save design theme:",
      expect.any(Error),
    );
  });

  it("applies the Bliss wallpaper when Windows XP is selected, leaving the dock untouched", async () => {
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Windows XP/ }));

    await waitFor(() => expect(shared.saveDesktopConfigPatchMock).toHaveBeenCalledTimes(1));
    expect(shared.saveDesktopConfigPatchMock).toHaveBeenCalledWith({
      background: { type: "wallpaper", name: "xp-bliss.svg" },
    });
  });

  it("applies the Bloom wallpaper when Windows 11 is selected, leaving the dock untouched", async () => {
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Windows 11/ }));

    await waitFor(() => expect(shared.saveDesktopConfigPatchMock).toHaveBeenCalledTimes(1));
    expect(shared.saveDesktopConfigPatchMock).toHaveBeenCalledWith({
      background: { type: "wallpaper", name: "win11-bloom.svg" },
    });
  });

  it("applies the first bundled wallpaper and moves the dock to the bottom when macOS 27 is selected", async () => {
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /macOS 27/ }));

    await waitFor(() => expect(shared.saveDesktopConfigPatchMock).toHaveBeenCalledTimes(1));
    expect(shared.saveDesktopConfigPatchMock).toHaveBeenCalledWith({
      background: { type: "wallpaper", name: "moraine-lake.jpg" },
      dock: { position: "bottom" },
    });
  });

  it("does not touch background or dock when Default is selected", async () => {
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Default/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(1));

    expect(shared.saveDesktopConfigPatchMock).not.toHaveBeenCalled();
  });

  it("does not apply desktop defaults when the theme save fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    shared.saveThemeMock.mockRejectedValueOnce(new Error("Failed to save theme"));
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Windows XP/ }));

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(shared.saveDesktopConfigPatchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[appearance] Failed to save design theme:",
      expect.any(Error),
    );
  });

  it("reports partial success when desktop defaults fail after the theme saved", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    shared.saveDesktopConfigPatchMock.mockRejectedValueOnce(new Error("PUT /api/settings/desktop 500"));
    const { getByRole } = render(<DesignPicker />);

    fireEvent.click(getByRole("button", { name: /Windows XP/ }));

    await waitFor(() => {
      const alert = getByRole("alert");
      expect(alert.textContent).toContain("Design applied");
      expect(alert.textContent).toContain("wallpaper");
      expect(alert.textContent).not.toContain("Couldn't apply that design");
      expect(alert.textContent).not.toContain("500");
    });
    // Theme save stays primary and is not rolled back.
    expect(shared.saveThemeMock).toHaveBeenCalledWith({ ...WINXP_THEME });
    expect(warnSpy).toHaveBeenCalledWith(
      "[appearance] Failed to apply design desktop defaults:",
      expect.any(Error),
    );
  });
});
