import type { UnifiedThemeVariant } from './theme-types.js';

export const FONT_OPTIONS = [
  { id: 'geist', label: 'Geist · Matrix default', family: 'Geist, "Matrix Geist", system-ui, sans-serif' },
  { id: 'inter', label: 'Inter', family: 'Inter, "Matrix Inter", system-ui, sans-serif' },
  { id: 'instrument', label: 'Instrument Sans', family: '"Instrument Sans", "Matrix Instrument Sans", system-ui, sans-serif' },
  { id: 'system', label: 'System sans', family: 'system-ui, -apple-system, sans-serif' },
  { id: 'serif', label: 'Serif', family: 'Georgia, "Times New Roman", serif' },
] as const;
export const MONO_FONT_OPTIONS = [
  { id: 'jetbrains', label: 'JetBrains Mono', family: '"JetBrains Mono", ui-monospace, monospace' },
  { id: 'system', label: 'System mono', family: 'ui-monospace, "SFMono-Regular", Consolas, monospace' },
] as const;
export type FontId = typeof FONT_OPTIONS[number]['id'];
export type MonoFontId = typeof MONO_FONT_OPTIONS[number]['id'];
export const COLOR_FIELDS = ['background', 'surface', 'text', 'accent', 'border'] as const;
export type CustomColors = Partial<Record<typeof COLOR_FIELDS[number], string>>;
export interface CustomTheme { baseThemeId: string; light: CustomColors; dark: CustomColors }
const HEX = /^#[\da-f]{6}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function normalizeCustomTheme(value: unknown): CustomTheme | null {
  if (!record(value) || typeof value.baseThemeId !== 'string' || !/^[a-z-]{1,32}$/.test(value.baseThemeId)) return null;
  const colors = (v: unknown): CustomColors => Object.fromEntries(COLOR_FIELDS.flatMap(key =>
    record(v) && typeof v[key] === 'string' && HEX.test(v[key]) ? [[key, v[key].toLowerCase()]] : []));
  return { baseThemeId: value.baseThemeId, light: colors(value.light), dark: colors(value.dark) };
}
export function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
export function contrastRatio(a: string, b: string): number {
  if (!HEX.test(a) || !HEX.test(b)) return 21;
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}
export function mix(a: string, b: string, amount: number): string {
  return '#' + [1, 3, 5].map(offset => Math.round(parseInt(a.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(b.slice(offset, offset + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
}
export function readable(color: string, backgrounds: string[], ratio = 4.5): string {
  if (!HEX.test(color) || backgrounds.some(bg => !HEX.test(bg))) return color;
  if (backgrounds.every(bg => contrastRatio(color, bg) >= ratio)) return color;
  const extremes = ['#0d0c0c', '#fafafa', '#000000', '#ffffff'];
  // A middle gray can satisfy both black and white custom surfaces.
  if (backgrounds.length > 1) for (let i = 0; i <= 255; i++) extremes.push('#' + i.toString(16).padStart(2, '0').repeat(3));
  const target = extremes.sort((a, b) => Math.min(...backgrounds.map(bg => contrastRatio(b, bg))) - Math.min(...backgrounds.map(bg => contrastRatio(a, bg))))[0]!;
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (backgrounds.every(bg => contrastRatio(candidate, bg) >= ratio)) return candidate;
  }
  return target;
}
/** One bounded, deterministic pass; retains hues while improving small-text contrast. */
export function polishVariant(source: UnifiedThemeVariant): UnifiedThemeVariant {
  const v = { chrome: { ...source.chrome }, terminal: { ...source.terminal }, editor: { ...source.editor } };
  const c = v.chrome;
  for (const key of ['chart1', 'chart2', 'chart3', 'chart4', 'chart5', 'destructive'] as const) c[key] = readable(c[key], [c.background, c.card]);
  c.foreground = readable(c.foreground, [c.background, c.card, c.popover, c.surface0, c.surface1, c.surface2, c.surface3, c.modal]);
  c.cardForeground = readable(c.cardForeground, [c.card]);
  c.popoverForeground = readable(c.popoverForeground, [c.popover]);
  c.mutedForeground = readable(c.mutedForeground, [c.background, c.card, c.accent]);
  c.primaryForeground = readable(c.primaryForeground, [c.primary]);
  c.secondaryForeground = readable(c.secondaryForeground, [c.secondary]);
  c.accentForeground = readable(c.accentForeground, [c.accent]);
  c.sidebarForeground = readable(c.sidebarForeground, [c.sidebar]);
  c.sidebarPrimaryForeground = readable(c.sidebarPrimaryForeground, [c.sidebarPrimary]);
  c.sidebarAccentForeground = readable(c.sidebarAccentForeground, [c.sidebarAccent]);
  for (const key of ['foreground', 'cursor', 'keyword', 'string', 'comment', 'number', 'function', 'type', 'operator', 'variable', 'property', 'link', 'heading', 'gutterForeground'] as const) {
    v.editor[key] = readable(v.editor[key], [v.editor.background]);
  }
  v.terminal.foreground = readable(v.terminal.foreground, [v.terminal.background]);
  v.terminal.cursor = readable(v.terminal.cursor, [v.terminal.background]);
  for (const key of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'] as const) {
    v.terminal[key] = readable(v.terminal[key], [v.terminal.background]);
  }
  return v;
}
export function customizeVariant(base: UnifiedThemeVariant, colors: CustomColors): UnifiedThemeVariant {
  const c = { ...base.chrome };
  if (colors.background) { c.background = colors.background; c.surface0 = colors.background; c.surface1 = colors.background; }
  if (colors.surface) {
    c.card = c.popover = c.sidebar = c.surface2 = c.surface3 = c.modal = colors.surface;
    const dark = luminance(colors.surface) < 0.3;
    c.accent = c.secondary = c.muted = c.sidebarAccent = mix(colors.surface, dark ? '#ffffff' : '#000000', 0.07);
  }
  if (colors.text) c.foreground = c.cardForeground = c.popoverForeground = c.sidebarForeground = c.secondaryForeground = c.accentForeground = c.sidebarAccentForeground = colors.text;
  if (colors.accent) c.primary = c.sidebarPrimary = colors.accent;
  if (colors.border) c.border = c.input = c.sidebarBorder = c.modalBorder = colors.border;
  return polishVariant({ chrome: c, terminal: { ...base.terminal, background: c.background, foreground: c.foreground, cursor: c.foreground, cursorAccent: c.background }, editor: { ...base.editor, background: c.background, foreground: c.foreground, gutterBackground: c.background, lineHighlight: c.accent, cursor: c.foreground } });
}
