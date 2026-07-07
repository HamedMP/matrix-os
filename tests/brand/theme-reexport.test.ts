import { describe, expect, it } from "vitest";
import { palette as brandPalette } from "@matrix-os/brand";
import { palette as landingPalette, cardShadow } from "../../www/src/components/landing/theme";

describe("landing theme re-exports the brand package", () => {
  it("keeps the same palette object values", () => {
    expect(landingPalette.forest).toBe(brandPalette.forest);
    expect(landingPalette.ember).toBe(brandPalette.ember);
  });
  it("keeps cardShadow", () => {
    expect(cardShadow).toBe("0 0 7.5rem 0 rgba(50, 53, 46, 0.09)");
  });
  it("re-exports palette by reference (not a copy)", () => {
    expect(landingPalette).toBe(brandPalette);
  });
});
