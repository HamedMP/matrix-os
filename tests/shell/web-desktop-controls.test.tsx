// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebDesktopControls } from "@/components/desktop/WebDesktopControls";

vi.mock("@/components/UserButton", () => ({
  UserButton: ({ onOpenSettings }: { onOpenSettings: (section?: "appearance" | "billing") => void }) => (
    <button type="button" onClick={() => onOpenSettings("billing")}>Account</button>
  ),
}));

describe("WebDesktopControls", () => {
  it("maps native Desktop right-side actions to web-safe navigation", () => {
    const onOpenSettings = vi.fn();
    const onOpenCommandPalette = vi.fn();
    render(
      <WebDesktopControls
        onOpenSettings={onOpenSettings}
        onOpenCommandPalette={onOpenCommandPalette}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Switch computer" }).getAttribute("href")).toBe("/runtime");
    expect(screen.getByRole("link", { name: "Support" }).getAttribute("href"))
      .toBe("https://matrix-os.com/docs");
    expect(Array.from(screen.getByRole("navigation", { name: "Desktop controls" }).children)
      .map((control) => control.getAttribute("aria-label") ?? control.textContent))
      .toEqual(["Search", "Support", "Switch computer", "Account"]);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(onOpenSettings).toHaveBeenCalledWith("billing");
  });
});
