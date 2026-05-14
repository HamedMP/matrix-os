// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileAppSurface } from "../../shell/src/components/mobile/MobileAppSurface.js";
import { MobileLauncher } from "../../shell/src/components/mobile/MobileLauncher.js";
import { useMobileViewport } from "../../shell/src/hooks/useMobileViewport.js";
import { setDesktopViewport, setPhoneViewport } from "./mobile-shell-test-utils.js";

function ViewportProbe() {
  const mobile = useMobileViewport();
  return <div data-testid="viewport-mode">{mobile ? "mobile" : "desktop"}</div>;
}

describe("mobile shell", () => {
  beforeEach(() => {
    setDesktopViewport();
  });

  it("uses launcher-first mode on phone-sized browser viewports", async () => {
    setPhoneViewport();

    render(<ViewportProbe />);

    await waitFor(() => expect(screen.getByTestId("viewport-mode").textContent).toBe("mobile"));
  });

  it("updates viewport mode when a phone viewport expands", () => {
    setPhoneViewport();
    render(<ViewportProbe />);

    act(() => {
      setDesktopViewport();
    });

    expect(screen.getByTestId("viewport-mode").textContent).toBe("desktop");
  });

  it("opens apps from the mobile launcher and shows active app state", () => {
    const onOpenApp = vi.fn();

    render(
      <MobileLauncher
        apps={[{ name: "Notes", path: "apps/notes/index.html" }]}
        openWindowPaths={new Set(["apps/notes/index.html"])}
        onOpenApp={onOpenApp}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-launcher-app-apps/notes/index.html"));

    expect(onOpenApp).toHaveBeenCalledWith("Notes", "apps/notes/index.html");
    expect(screen.getByLabelText("Open")).toBeTruthy();
  });

  it("offers an explicit resume action for the last mobile app", () => {
    const onResumeApp = vi.fn();

    render(
      <MobileLauncher
        apps={[
          { name: "Notes", path: "apps/notes/index.html" },
          { name: "Tasks", path: "__workspace__" },
        ]}
        openWindowPaths={new Set()}
        onOpenApp={vi.fn()}
        resumeApp={{ name: "Notes", path: "apps/notes/index.html" }}
        onResumeApp={onResumeApp}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-resume-app"));

    expect(onResumeApp).toHaveBeenCalledWith("Notes", "apps/notes/index.html");
  });

  it("returns home from a full-screen mobile app without unmounting content", () => {
    const onHome = vi.fn();

    render(
      <MobileAppSurface title="Notes" onHome={onHome}>
        <div data-testid="runtime-content">runtime</div>
      </MobileAppSurface>,
    );

    fireEvent.click(screen.getByTestId("mobile-home-button"));

    expect(onHome).toHaveBeenCalled();
    expect(screen.getByTestId("runtime-content")).toBeTruthy();
  });

  it("keeps app content inside the mobile surface viewport", () => {
    render(
      <MobileAppSurface title="Terminal" onHome={vi.fn()}>
        <div data-testid="terminal-content" className="h-full w-full overflow-hidden" />
      </MobileAppSurface>,
    );

    expect(screen.getByTestId("mobile-app-surface").className).toContain("overflow");
    expect(screen.getByTestId("terminal-content")).toBeTruthy();
  });

  it("shows a safe fallback when a restored mobile app is missing", () => {
    render(
      <MobileAppSurface title="Missing app" onHome={vi.fn()} unavailableMessage="Open the app from the launcher again." />,
    );

    expect(screen.getByText("App unavailable")).toBeTruthy();
    expect(screen.getByText("Open the app from the launcher again.")).toBeTruthy();
  });
});
