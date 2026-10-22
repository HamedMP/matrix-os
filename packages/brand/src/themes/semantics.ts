import { productScales as s } from '../tokens.js';
import { contrastRatio, luminance, mix, readable } from './customization.js';
import type { ChromeColors } from './theme-types.js';

/** Status fills, status text and interaction states have distinct roles. */
export function themeSemantics(c: ChromeColors, paletteId = 'matrix') {
  const dark = luminance(c.background) < 0.3;
  const foreground = (fill: string) => contrastRatio(s.neutral[900], fill) >= 4.5 ? s.neutral[900] : s.neutral[25];
  // Matrix's neutral actions intentionally reveal its brand green on hover.
  // Other presets and custom accents retain their own palette identity.
  const matrixHover = paletteId === 'matrix' || paletteId === 'matrix-neon';
  const primaryHover = matrixHover ? dark ? s.green[300] : s.green[700]
    : mix(c.primary, c.primary === c.background ? c.foreground : c.background, 0.12);
  const status = (scale: typeof s.teal | typeof s.gold | typeof s.coral | typeof s.blue, textStep: 600 | 700) => {
    const fill: string = scale[dark ? 300 : 500];
    const muted = scale[dark ? 900 : 50];
    const text = scale[dark ? 200 : textStep];
    // Text on brand tints is checked independently from solid button fills.
    return { fill, muted, text: readable(text, [muted]), foreground: foreground(fill) };
  };
  const success = status(s.teal, 700);
  const warning = status(s.gold, 700);
  const danger = status(s.coral, 600);
  const info = status(s.blue, 700);
  if (dark) { info.fill = s.blue[200]; info.foreground = foreground(info.fill); }
  return {
    accentText: readable(c.primary, [c.accent]),
    primaryHover, primaryHoverForeground: matrixHover ? foreground(primaryHover) : readable(c.primaryForeground, [primaryHover]),
    success: success.fill, successMuted: success.muted, successText: success.text, successForeground: success.foreground,
    warning: warning.fill, warningMuted: warning.muted, warningText: warning.text, warningForeground: warning.foreground,
    danger: danger.fill, dangerMuted: danger.muted, dangerText: danger.text, dangerForeground: danger.foreground,
    info: info.fill, infoMuted: info.muted, infoText: info.text, infoForeground: info.foreground,
  };
}
