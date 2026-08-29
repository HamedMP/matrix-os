// @vitest-environment jsdom

import React from "react";
import { createPortal } from "react-dom";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopWorkspacePlane from "@desktop/renderer/src/features/desktop-shell/DesktopWorkspacePlane";
import { DesktopTerminalThemePicker } from "@desktop/renderer/src/features/terminal/DesktopTerminalThemePicker";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
import { useTerminalAppearance } from "@desktop/renderer/src/stores/terminal-appearance";

beforeEach(() => {
  useNativeDesktopMode.setState(useNativeDesktopMode.getInitialState(), true);
  useTerminalAppearance.setState(useTerminalAppearance.getInitialState(), true);
  window.operator = {
    invoke: vi.fn(async () => ({ ok: true })),
    on: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("PointerEvent", MouseEvent);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWorkspace(mode: "desktop" | "canvas") {
  const onBackgroundClick = vi.fn();
  const onMenuClick = vi.fn();
  render(
    <DesktopWorkspacePlane mode={mode} onBackgroundClick={onBackgroundClick}>
      <div data-desktop-surface="app">
        <div data-testid="app-content">App content</div>
        {createPortal(
          <div role="menu">
            <div role="menuitemradio" aria-checked="false" onClick={onMenuClick}>
              <span data-testid="portal-item">A theme</span>
            </div>
            <div data-testid="portal-padding">Menu padding</div>
          </div>,
          document.body,
        )}
      </div>
      <div data-testid="other-child">Not desktop background</div>
    </DesktopWorkspacePlane>,
  );
  return { onBackgroundClick, onMenuClick };
}

describe("workspace background event boundary", () => {
  it("allows the actual Terminal theme picker to change themes without showing desktop", async () => {
    const onBackgroundClick = vi.fn();
    render(
      <DesktopWorkspacePlane mode="desktop" onBackgroundClick={onBackgroundClick}>
        <div data-desktop-surface="terminal"><DesktopTerminalThemePicker /></div>
      </DesktopWorkspacePlane>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Theme" }), { button: 0, ctrlKey: false });
    const option = await screen.findByRole("menuitemradio", { name: /Light/ });
    expect(option.closest("[data-desktop-surface]")).toBeNull();
    fireEvent.click(option);
    expect(useTerminalAppearance.getState().appThemeId).toBe("light");
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it("accepts only direct background clicks, including the empty transform plane", () => {
    const { onBackgroundClick } = renderWorkspace("desktop");
    fireEvent.click(screen.getByTestId("native-desktop-workspace"));
    fireEvent.click(screen.getByTestId("native-desktop-workspace-plane"));
    expect(onBackgroundClick).toHaveBeenCalledTimes(2);
  });

  it("lets portaled menu selections run without showing desktop", () => {
    const { onBackgroundClick, onMenuClick } = renderWorkspace("desktop");
    fireEvent.click(screen.getByTestId("portal-item"));
    expect(onMenuClick).toHaveBeenCalledOnce();
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it.each(["portal-padding", "app-content", "other-child"])(
    "does not treat %s as background",
    (target) => {
      const { onBackgroundClick } = renderWorkspace("desktop");
      fireEvent.click(screen.getByTestId(target));
      expect(onBackgroundClick).not.toHaveBeenCalled();
    },
  );

  it("ignores secondary clicks and does not show desktop in canvas mode", () => {
    const { onBackgroundClick } = renderWorkspace("desktop");
    fireEvent.click(screen.getByTestId("native-desktop-workspace"), { button: 2 });
    expect(onBackgroundClick).not.toHaveBeenCalled();
    cleanup();
    const canvas = renderWorkspace("canvas");
    fireEvent.click(screen.getByTestId("native-desktop-canvas"));
    expect(canvas.onBackgroundClick).not.toHaveBeenCalled();
  });

  it.each(["desktop", "canvas"] as const)("respects prevented background events in %s mode", (mode) => {
    const onBackgroundClick = vi.fn();
    render(
      <DesktopWorkspacePlane
        mode={mode}
        onBackgroundClick={onBackgroundClick}
        onClickCapture={(event) => event.preventDefault()}
        onPointerDownCapture={(event) => event.preventDefault()}
      >
        {null}
      </DesktopWorkspacePlane>,
    );
    const background = screen.getByTestId("native-desktop-workspace-plane");
    fireEvent.click(background);
    fireEvent.pointerDown(background, { button: 0, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 50 });
    fireEvent.pointerUp(window);
    const wheel = createEvent.wheel(background, { ctrlKey: true, deltaY: -100, cancelable: true });
    wheel.preventDefault();
    fireEvent(background, wheel);
    expect(onBackgroundClick).not.toHaveBeenCalled();
    expect(useNativeDesktopMode.getState()).toMatchObject({ panX: 0, panY: 0, zoom: 1 });
  });

  it.each(["native-desktop-canvas", "native-desktop-workspace-plane"])(
    "preserves pan and zoom on %s",
    (target) => {
      renderWorkspace("canvas");
      fireEvent.pointerDown(screen.getByTestId(target), { button: 0, clientX: 10, clientY: 20 });
      fireEvent.pointerMove(window, { clientX: 30, clientY: 50 });
      fireEvent.pointerUp(window);
      expect(useNativeDesktopMode.getState()).toMatchObject({ panX: 20, panY: 30 });
      fireEvent.wheel(screen.getByTestId(target), { ctrlKey: true, deltaY: -100 });
      expect(useNativeDesktopMode.getState().zoom).toBeGreaterThan(1);
    },
  );

  it.each(["portal-item", "portal-padding", "app-content", "other-child"])(
    "does not pan or zoom the canvas from %s",
    (target) => {
      renderWorkspace("canvas");
      fireEvent.pointerDown(screen.getByTestId(target), { button: 0, clientX: 10, clientY: 20 });
      fireEvent.pointerMove(window, { clientX: 30, clientY: 50 });
      fireEvent.pointerUp(window);
      fireEvent.wheel(screen.getByTestId(target), { ctrlKey: true, deltaY: -100 });
      expect(useNativeDesktopMode.getState()).toMatchObject({ panX: 0, panY: 0, zoom: 1 });
    },
  );
});
