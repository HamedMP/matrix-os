// @vitest-environment jsdom

import React from "react";
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DesktopWorkspacePlane from "@desktop/renderer/src/features/desktop-shell/DesktopWorkspacePlane";

afterEach(cleanup);

describe("DesktopWorkspacePlane", () => {
  it("does not treat a portaled surface menu item as a desktop-background click", () => {
    const onBackgroundClick = vi.fn();
    render(
      <DesktopWorkspacePlane mode="desktop" onBackgroundClick={onBackgroundClick}>
        <section data-desktop-surface="chat">
          {createPortal(<div role="menuitem">New terminal</div>, document.body)}
        </section>
      </DesktopWorkspacePlane>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "New terminal" }));

    expect(onBackgroundClick).not.toHaveBeenCalled();
  });
});
