// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandPanel } from "../../desktop/src/renderer/src/design/BrandPanel";

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
});
