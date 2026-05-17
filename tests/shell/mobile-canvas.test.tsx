// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileAppSurface } from "../../shell/src/components/mobile/MobileAppSurface.js";
import { MobileLauncher } from "../../shell/src/components/mobile/MobileLauncher.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";

describe("mobile Canvas entry", () => {
  it("opens Canvas only through an explicit launcher action", () => {
    const onOpenCanvas = vi.fn();

    render(
      <MobileLauncher
        apps={[{ name: "Notes", path: "apps/notes/index.html" }]}
        openWindowPaths={new Set()}
        onOpenApp={vi.fn()}
        onOpenCanvas={onOpenCanvas}
      />,
    );

    expect(screen.getByTestId("mobile-launcher")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-open-canvas"));

    expect(onOpenCanvas).toHaveBeenCalledTimes(1);
  });

  it("wraps Canvas in a full-screen mobile surface with a return-home control", () => {
    const onHome = vi.fn();

    render(
      <MobileAppSurface title="Canvas" onHome={onHome}>
        <div data-testid="canvas-content" className="h-full w-full overflow-hidden" />
      </MobileAppSurface>,
    );

    fireEvent.click(screen.getByTestId("mobile-home-button"));

    expect(onHome).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mobile-app-surface").className).toContain("overflow-hidden");
    expect(screen.getByTestId("canvas-content")).toBeTruthy();
  });

  it("can reset stale Canvas pan and zoom before mobile entry", () => {
    useCanvasTransform.getState().setTransform(0.2, 7000, -7000);

    useCanvasTransform.getState().resetForMobileViewport();

    expect(useCanvasTransform.getState()).toMatchObject({
      zoom: 1,
      panX: 0,
      panY: 0,
      isScrolling: false,
    });
  });
});
