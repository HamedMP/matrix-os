// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MissionControlContentSurface } from "../../desktop/src/renderer/src/features/mission-control/MissionControl";

describe("Desktop mission control shell", () => {
  afterEach(() => cleanup());

  it.each([
    { collapsed: false, expectedLeft: "var(--sidebar-expanded-width)" },
    { collapsed: true, expectedLeft: "4px" },
  ])("owns the Figma content surface when collapsed=$collapsed", ({ collapsed, expectedLeft }) => {
    render(
      <MissionControlContentSurface collapsed={collapsed}>
        <span>Content</span>
      </MissionControlContentSurface>,
    );

    const surface = screen.getByTestId("mission-control-content-surface");
    expect(surface.style.left).toBe(expectedLeft);
    expect(surface.style.top).toBe("var(--titlebar-height)");
    expect(surface.style.right).toBe("4px");
    expect(surface.style.bottom).toBe("4px");
    expect(surface.style.border).toBe("1px solid var(--border-subtle)");
    expect(surface.style.borderRadius).toBe("var(--radius)");
    expect(surface.style.overflow).toBe("hidden");
  });
});
