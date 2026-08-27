// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderGlyph } from "../../desktop/src/renderer/src/features/settings/provider-glyph";

describe("ProviderGlyph", () => {
  afterEach(() => {
    cleanup();
  });

  const kinds = ["claude", "codex", "opencode", "cursor", "pi", "custom"] as const;

  it.each(kinds)("renders the %s glyph", (kind) => {
    const { container } = render(<ProviderGlyph kind={kind} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps a distinct bundled glyph for each provider kind", () => {
    const glyphs = kinds.map((kind) => {
      const { container, unmount } = render(<ProviderGlyph kind={kind} />);
      const markup = container.querySelector("svg")?.innerHTML;
      unmount();
      return markup;
    });

    expect(new Set(glyphs).size).toBe(kinds.length);
  });

  it("renders pi with the shared accent chrome", () => {
    const { container } = render(<ProviderGlyph kind="pi" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper?.className).toContain("h-8");
    expect(wrapper?.className).toContain("w-8");
  });
});
