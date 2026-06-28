import { describe, expect, it } from "vitest";
import { palette, fonts, cardShadow } from "@matrix-os/brand";

describe("@matrix-os/brand tokens", () => {
  it("exposes the canonical landing palette", () => {
    expect(palette.forest).toBe("#434E3F");
    expect(palette.ember).toBe("#D06F25");
    expect(palette.cream).toBe("#E0E1CA");
    expect(palette.pageBg).toBe("#EEEEE2");
    expect(palette.card).toBe("#FCFCF8");
    expect(palette.border).toBe("#DCD9CC");
    expect(palette.deep).toBe("#32352E");
  });
  it("exposes Instrument display + sans fonts", () => {
    expect(fonts.display).toContain("Instrument Serif");
    expect(fonts.sans).toContain("Instrument Sans");
  });
  it("exposes the landing card shadow", () => {
    expect(cardShadow).toBe("0 0 7.5rem 0 rgba(50, 53, 46, 0.09)");
  });
});
