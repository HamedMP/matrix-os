// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  saveThemeMock: vi.fn(),
  theme: {
    name: "default",
    style: "flat",
    colors: {},
    fonts: {},
    radius: "0.75rem",
  } as { name: string; style?: string; colors: Record<string, string>; fonts: Record<string, string>; radius: string },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => shared.theme,
  saveTheme: shared.saveThemeMock,
  DEFAULT_THEME: { name: "default", colors: {}, fonts: {}, radius: "0.75rem" },
}));

import { DesignPicker } from "../../shell/src/components/settings/DesignPicker.js";
import {
  MACOS_GLASS_THEME,
  RETRO_THEME,
  WIN11_THEME,
  WINXP_THEME,
} from "../../shell/src/lib/theme-presets.js";

const DESIGN_LABELS = ["Default", "Retro", "macOS 27", "Windows XP", "Windows 11"] as const;

function resetTheme(style?: string) {
  shared.theme = { name: "default", colors: {}, fonts: {}, radius: "0.75rem" };
  if (style) shared.theme.style = style;
}

describe("DesignPicker", () => {
  beforeEach(() => {
    shared.saveThemeMock.mockReset();
    shared.saveThemeMock.mockResolvedValue(undefined);
    resetTheme("flat");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all five design options", () => {
    const { getByRole, getAllByRole } = render(<DesignPicker />);

    expect(getByRole("heading", { name: "Design" })).toBeTruthy();
    expect(getAllByRole("button")).toHaveLength(5);
    for (const label of DESIGN_LABELS) {
      expect(getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it("marks the active design from theme.style", () => {
    resetTheme("winxp");
    const { getByRole } = render(<DesignPicker />);

    expect(getByRole("button", { name: /Windows XP/ }).getAttribute("aria-pressed")).toBe("true");
    for (const label of ["Default", "Retro", "macOS 27", "Windows 11"]) {
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

    fireEvent.click(getByRole("button", { name: /Retro/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(2));
    expect(shared.saveThemeMock).toHaveBeenLastCalledWith({ ...RETRO_THEME });

    fireEvent.click(getByRole("button", { name: /macOS 27/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(3));
    expect(shared.saveThemeMock).toHaveBeenLastCalledWith({ ...MACOS_GLASS_THEME });

    fireEvent.click(getByRole("button", { name: /Windows 11/ }));
    await waitFor(() => expect(shared.saveThemeMock).toHaveBeenCalledTimes(4));
    expect(shared.saveThemeMock).toHaveBeenLastCalledWith({ ...WIN11_THEME });
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

    fireEvent.click(getByRole("button", { name: /Retro/ }));

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
});
