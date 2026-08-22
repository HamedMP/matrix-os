import { describe, expect, it } from "vitest";
import { getTerminalAppearanceTokens } from "../../desktop/src/renderer/src/features/terminal/terminal-appearance";

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Desktop Terminal appearance", () => {
  it("keeps light-mode metadata and controls above accessible contrast thresholds", () => {
    const light = getTerminalAppearanceTokens("light");

    expect(contrastRatio(light.muted, light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.muted, light.control)).toBeGreaterThanOrEqual(3);
  });
});
