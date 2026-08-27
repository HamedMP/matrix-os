import { describe, expect, it } from "vitest";

import { rabbitMarkSvg } from "@matrix-os/brand/marks";

describe("Matrix OS brand marks", () => {
  it("renders the canonical rabbit as a current-color inline SVG", () => {
    const svg = rabbitMarkSvg("rabbit-mark success-rabbit");

    expect(svg).toContain('<svg class="rabbit-mark success-rabbit"');
    expect(svg).toContain('viewBox="0 0 510 660"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg.match(/<path /g)).toHaveLength(11);
  });

  it("rejects class values that could inject markup", () => {
    expect(() => rabbitMarkSvg('rabbit-mark" onload="alert(1)')).toThrow(
      "Rabbit mark class names must be CSS identifiers separated by spaces",
    );
  });
});
