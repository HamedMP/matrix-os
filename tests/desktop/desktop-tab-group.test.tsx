// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { Monitor, PanelLeft } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import DesktopTab from "../../desktop/src/renderer/src/features/desktop-shell/DesktopTab";
import DesktopTabGroup from "../../desktop/src/renderer/src/features/desktop-shell/DesktopTabGroup";

describe("DesktopTabGroup", () => {
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
