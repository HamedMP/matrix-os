// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../desktop/src/renderer/src/assets/matrix-logo.svg", () => ({
  default: "matrix-logo.svg",
}));

import { BrandLogo, BrandPanel } from "../../desktop/src/renderer/src/design/BrandPanel";

describe("desktop sign-in brand panel", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses the real Matrix logo as both the visible mark and the oversized ambient mark", () => {
    render(
      <BrandPanel
        title={
          <>
            Code on your
            <br />
            cloud computer
          </>
        }
        subtitle="Every user gets a private VPS with shell, files, apps, and AI agents."
        bullets={[
          { icon: <span />, label: "No local setup required" },
          { icon: <span />, label: "Works with GitHub" },
          { icon: <span />, label: "Claude / Codex / OpenCode ready" },
        ]}
      />,
    );

    const visibleMark = screen.getByTestId("matrix-brand-visible-mark");
    const ambientMark = screen.getByTestId("matrix-brand-ambient-mark");

    expect(visibleMark.style.maskImage).toContain("matrix-logo.svg");
    expect(ambientMark.style.maskImage).toContain("matrix-logo.svg");
    expect(ambientMark.style.height).toBe("1240px");
    expect(ambientMark.style.width).toBe("958px");
    expect(ambientMark.className).toContain("opacity");
    expect(screen.getByText("Matrix OS")).toBeTruthy();
  });

  it("keeps the Matrix logo mask intact when callers pass style overrides", () => {
    render(<BrandLogo testId="matrix-brand-logo" style={{ maskImage: "none", background: "transparent" }} />);

    const logo = screen.getByTestId("matrix-brand-logo");

    expect(logo.style.maskImage).toContain("matrix-logo.svg");
    expect(logo.style.background).toBe("var(--accent)");
  });
});
