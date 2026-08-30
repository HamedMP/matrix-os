// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NavigationHeader from "../../desktop/src/renderer/src/features/mission-control/NavigationHeader";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("Desktop navigation header", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().ensureNavigationScope("runtime-a");
    useUi.setState(useUi.getInitialState(), true);
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn() },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { operator?: unknown }).operator;
  });

  it("removes sidebar-only chrome for the native desktop shell", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    expect(screen.getByRole("banner").style.gridTemplateColumns)
      .toBe("96px minmax(0, 1fr)");
  });

  it("uses permanent workspace tabs instead of Browser breadcrumbs or actions in native desktop", () => {
    useTabs.getState().openTab({ kind: "home", title: "Browser", closable: false });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    expect(screen.getByRole("tab", { name: "Desktop" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions for Browser" })).toBeNull();
  });

  it("toggles the native window when the titlebar background is double-clicked", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.doubleClick(screen.getByRole("banner"));

    expect(window.operator.invoke).toHaveBeenCalledWith("window:toggle-maximize", {});
  });

  it("does not toggle the native window when a titlebar tab is double-clicked", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Desktop" }));

    expect(window.operator.invoke).not.toHaveBeenCalledWith("window:toggle-maximize", {});
  });

  it("leaves the native titlebar drag region available for OS window gestures", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    expect(screen.getByRole("banner").classList.contains("titlebar-drag")).toBe(true);
    expect(screen.getByRole("tablist", { name: "Workspace tabs" })
      .classList.contains("titlebar-drag")).toBe(true);
  });

  it("uses Figma-style native top-bar controls without a mode switcher", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    const desktopTab = screen.getByRole("tab", { name: "Desktop" });
    expect(desktopTab.textContent).toBe("");
    expect(screen.getByRole("tab", { name: "Sidebar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open account menu" })).toBeTruthy();
    expect(screen.queryByLabelText("Workspace mode")).toBeNull();
  });

});
