// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderGlyph } from "../../desktop/src/renderer/src/features/settings/provider-glyph";

describe("ProviderGlyph", () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    ["claude", "lucide-sparkles"],
    ["codex", "lucide-square-terminal"],
    ["opencode", "lucide-code-xml"],
    ["cursor", "lucide-mouse-pointer2"],
    ["pi", "lucide-pi"],
    ["custom", "lucide-cpu"],
  ] as const)("renders the %s glyph", (kind, iconClass) => {
    const { container } = render(<ProviderGlyph kind={kind} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.classList.contains(iconClass)).toBe(true);
  });

  it("renders pi with the shared accent chrome", () => {
    const { container } = render(<ProviderGlyph kind="pi" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper?.className).toContain("h-8");
    expect(wrapper?.className).toContain("w-8");
  });
});
