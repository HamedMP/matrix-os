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
    render(<WebDesktopControls onOpenSettings={onOpenSettings} />);

    expect(screen.getByRole("link", { name: "Switch computer" }).getAttribute("href")).toBe("/runtime");
    const support = screen.getByRole("link", { name: "Support" });
    expect(support.getAttribute("href")).toBe("https://matrix-os.com/docs");
    expect(support.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(onOpenSettings).toHaveBeenCalledWith("billing");
  });
});
