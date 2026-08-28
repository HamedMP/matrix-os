// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { Monitor, PanelLeft } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import DesktopTab from "../../desktop/src/renderer/src/features/desktop-shell/DesktopTab";
import DesktopTabGroup from "../../desktop/src/renderer/src/features/desktop-shell/DesktopTabGroup";

describe("DesktopTabGroup", () => {
  it("keeps the workspace tab row available as a native window drag surface", () => {
    render(
      <DesktopTabGroup>
        <DesktopTab mode="iconOnly" label="Sidebar" icon={<PanelLeft />} onClick={vi.fn()} />
        <DesktopTab mode="iconOnly" label="Desktop" icon={<Monitor />} onClick={vi.fn()} />
      </DesktopTabGroup>,
    );

    const tablist = screen.getByRole("tablist", { name: "Workspace tabs" });
    expect(tablist.classList.contains("titlebar-drag")).toBe(true);
    expect(tablist.classList.contains("no-drag")).toBe(false);
    expect(screen.getAllByRole("tab").every((tab) => (
      tab.tagName === "BUTTON" && tab.classList.contains("no-drag")
    ))).toBe(true);
  });

  it("keeps the non-interactive body of a full workspace tab draggable", () => {
    render(
      <DesktopTab
        mode="full"
        label="Browser"
        icon={<Monitor />}
        canClose
        onClick={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const browserTab = screen.getByRole("tab", { name: "Browser" });
    const tabBody = browserTab.closest("[data-desktop-tab]");
    expect(tabBody?.classList.contains("titlebar-drag")).toBe(true);
    expect(tabBody?.classList.contains("no-drag")).toBe(false);
    expect(browserTab.tagName).toBe("BUTTON");
    expect(browserTab.classList.contains("no-drag")).toBe(true);
    expect(screen.getByRole("button", { name: "Minimize Browser tab" }).classList.contains("no-drag")).toBe(true);
    expect(screen.getByRole("button", { name: "Close Browser" }).classList.contains("no-drag")).toBe(true);
  });

  it("gives every tab a left border and only the final tab a right border", () => {
    render(
      <DesktopTabGroup>
        <DesktopTab mode="iconOnly" label="Sidebar" icon={<PanelLeft />} onClick={vi.fn()} />
        <DesktopTab mode="iconOnly" label="Desktop" icon={<Monitor />} onClick={vi.fn()} />
      </DesktopTabGroup>,
    );

    const sidebar = screen.getByRole("tab", { name: "Sidebar" });
    const desktop = screen.getByRole("tab", { name: "Desktop" });
    expect(sidebar.style.borderLeft).toBe("1px solid var(--border-default, #F3F2F2)");
    expect(sidebar.style.borderRight).toBe("");
    expect(desktop.style.borderLeft).toBe("1px solid var(--border-default, #F3F2F2)");
    expect(desktop.style.borderRight).toBe("1px solid var(--border-default, #F3F2F2)");
  });
});
