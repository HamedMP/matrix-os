import { describe, expect, it } from "vitest";
import {
  computeSoftGridLayout,
  correctTerminalPointerCoordinates,
} from "../../shell/src/components/terminal/terminal-soft-grid.js";
import { parseTerminalServerMessage } from "../../shell/src/components/terminal/terminal-server-message.js";

describe("terminal soft-client canonical grid", () => {
  it("keeps a 140x40 logical grid readable and horizontally pannable in a 70-column viewport", () => {
    const layout = computeSoftGridLayout({
      viewportWidth: 700,
      viewportHeight: 800,
      gridWidth: 1_400,
      gridHeight: 800,
      configuredFontSize: 13,
      minimumReadableFontSize: 10,
      devicePixelRatio: 2,
    });

    expect(layout.fontSize).toBe(10);
    expect(layout.scale).toBe(1);
    expect(layout.visualWidth).toBeCloseTo(1_400 * (10 / 13));
    expect(layout.visualHeight).toBeCloseTo(800 * (10 / 13));
    expect(layout.panX).toBe(true);
    expect(layout.panY).toBe(false);
  });

  it("does not stretch a canonical grid when the browser is wider than it", () => {
    expect(computeSoftGridLayout({
      viewportWidth: 1_600,
      viewportHeight: 900,
      gridWidth: 1_400,
      gridHeight: 800,
      configuredFontSize: 13,
      minimumReadableFontSize: 10,
      devicePixelRatio: 2,
    })).toEqual({
      fontSize: 13,
      scale: 1,
      visualWidth: 1_400,
      visualHeight: 800,
      panX: false,
      panY: false,
    });
  });

  it("uses device-pixel font sizing plus a fractional transform when the grid can remain legible", () => {
    const layout = computeSoftGridLayout({
      viewportWidth: 1_200,
      viewportHeight: 900,
      gridWidth: 1_400,
      gridHeight: 800,
      configuredFontSize: 13,
      minimumReadableFontSize: 10,
      devicePixelRatio: 2,
    });

    expect(layout.fontSize).toBe(11.5);
    expect(layout.scale).toBeCloseTo((1_200 / 1_400) / (11.5 / 13));
    expect(layout.visualWidth).toBeCloseTo(1_200);
    expect(layout.panX).toBe(false);
  });

  it("translates mouse coordinates through both Canvas zoom and soft-grid scale", () => {
    const corrected = correctTerminalPointerCoordinates({
      clientX: 425,
      clientY: 312.5,
      rectLeft: 200,
      rectTop: 200,
      canvasZoom: 1.5,
      gridScale: 0.75,
    });

    expect(corrected).toEqual({ clientX: 400, clientY: 300 });
    expect((corrected.clientX - 200) / 10).toBe(20);
    expect((corrected.clientY - 200) / 20).toBe(5);
  });

  it("accepts authoritative canonical dimensions on attach and later size changes", () => {
    expect(parseTerminalServerMessage(JSON.stringify({
      type: "attached",
      session: "main",
      state: "running",
      fromSeq: 0,
      canonicalSize: { cols: 140, rows: 40 },
    }))).toEqual({
      type: "attached",
      sessionId: "main",
      state: "running",
      exitCode: null,
      fromSeq: 0,
      canonicalSize: { cols: 140, rows: 40 },
    });
    expect(parseTerminalServerMessage(JSON.stringify({
      type: "canonical-size",
      cols: 132,
      rows: 36,
    }))).toEqual({ type: "canonical-size", cols: 132, rows: 36 });
  });

  it("rejects out-of-bounds canonical dimensions", () => {
    expect(parseTerminalServerMessage(JSON.stringify({
      type: "canonical-size",
      cols: 501,
      rows: 40,
    }))).toBeNull();
  });

  it("accepts live-lease revocation frames", () => {
    expect(parseTerminalServerMessage(JSON.stringify({ type: "lease-revoked", epoch: 7 }))).toEqual({
      type: "lease-revoked",
    });
    expect(parseTerminalServerMessage(JSON.stringify({ type: "presentation-reset" }))).toEqual({
      type: "presentation-reset",
    });
  });
});
