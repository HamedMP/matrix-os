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

vi.mock("@/components/onboarding/GettingStartedPopover", () => ({
  GettingStartedPopover: ({
    onOpenSettings,
    onOpenFirstWork,
  }: {
    onOpenSettings: (section: "integrations" | "agents-providers" | "billing") => void;
    onOpenFirstWork: () => void;
  }) => (
    <button type="button" aria-label="Getting started — 0 of 5" onClick={() => {
      onOpenSettings("integrations");
      onOpenFirstWork();
    }}>
      Getting started
    </button>
  ),
}));

describe("WebDesktopControls", () => {
  it("maps native Desktop right-side actions to web-safe navigation", () => {
    const onOpenSettings = vi.fn();
    const onOpenCommandPalette = vi.fn();
    const onOpenSupport = vi.fn();
    const onOpenFirstWork = vi.fn();
    render(
      <WebDesktopControls
        onOpenSettings={onOpenSettings}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenSupport={onOpenSupport}
        onOpenFirstWork={onOpenFirstWork}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Switch computer" }).getAttribute("href")).toBe("/runtime");
    fireEvent.click(screen.getByRole("button", { name: "Support chat" }));
    expect(onOpenSupport).toHaveBeenCalledOnce();
    const discord = screen.getByRole("link", { name: "Join Discord" });
    expect(discord.getAttribute("href")).toBe("https://discord.gg/WHbvTG33w");
    expect(discord.getAttribute("target")).toBe("_blank");
    expect(discord.getAttribute("rel")).toBe("noopener noreferrer");
    expect(Array.from(screen.getByRole("navigation", { name: "Desktop controls" }).children)
      .map((control) => control.getAttribute("aria-label") ?? control.textContent))
      .toEqual(["Search", "Support chat", "Join Discord", "Switch computer", "Getting started — 0 of 5", "Account"]);
    fireEvent.click(screen.getByRole("button", { name: "Getting started — 0 of 5" }));
    expect(onOpenSettings).toHaveBeenCalledWith("integrations");
    expect(onOpenFirstWork).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(onOpenSettings).toHaveBeenCalledWith("billing");
  });
});
