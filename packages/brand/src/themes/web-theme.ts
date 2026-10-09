import { getThemeVariant, FONT_OPTIONS, MONO_FONT_OPTIONS } from './index.js';
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearancePreferences } from './preferences.js';

/** Compatibility projection for the file-backed Web Canvas/Web Desktop theme. */
export function buildWebTheme(input: AppearancePreferences = DEFAULT_APPEARANCE, systemDark = false) {
  const appearance = normalizeAppearance(input);
  const mode = appearance.mode === 'system' ? systemDark ? 'dark' : 'light' : appearance.mode;
  const { chrome: c } = getThemeVariant(appearance.themeId, mode, appearance.customTheme);
  return {
    name: appearance.themeId, mode, appearance,
    colors: {
      background: c.background, foreground: c.foreground, card: c.card, 'card-foreground': c.cardForeground,
      popover: c.popover, 'popover-foreground': c.popoverForeground, primary: c.primary, 'primary-foreground': c.primaryForeground,
      secondary: c.secondary, 'secondary-foreground': c.secondaryForeground, muted: c.muted, 'muted-foreground': c.mutedForeground,
      accent: c.accent, 'accent-foreground': c.accentForeground, destructive: c.destructive, success: c.chart2, warning: c.chart3,
      border: c.border, input: c.input, ring: c.ring,
      sidebar: c.sidebar, 'sidebar-foreground': c.sidebarForeground,
      'sidebar-primary': c.sidebarPrimary, 'sidebar-primary-foreground': c.sidebarPrimaryForeground,
      'sidebar-accent': c.sidebarAccent, 'sidebar-accent-foreground': c.sidebarAccentForeground,
      'sidebar-border': c.sidebarBorder, 'sidebar-ring': c.sidebarRing,
    },
    fonts: { sans: FONT_OPTIONS.find(f => f.id === appearance.fontId)!.family, mono: MONO_FONT_OPTIONS.find(f => f.id === appearance.monoFontId)!.family },
    radius: '0.75rem',
  };
}

/** Preserve older file themes when opening the new controls or changing a font. */
export function appearanceFromWebTheme(theme: { name: string; mode?: 'light' | 'dark'; colors: Record<string, string>; fonts: Record<string, string>; appearance?: AppearancePreferences }): AppearancePreferences {
  if (theme.appearance) return normalizeAppearance(theme.appearance);
  const mode = theme.mode ?? (theme.colors.background && parseInt(theme.colors.background.slice(1, 3), 16) < 128 ? 'dark' : 'light');
  const baseThemeId = theme.name === 'matrix' ? 'matrix-neon' : ['nord', 'dracula'].includes(theme.name) ? theme.name : 'matrix';
  const colors = Object.fromEntries(Object.entries({ background: theme.colors.background, surface: theme.colors.card, text: theme.colors.foreground, accent: theme.colors.primary, border: theme.colors.border }).filter(([, value]) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)));
  return normalizeAppearance({ mode, themeId: 'custom', fontId: /Inter/i.test(theme.fonts.sans ?? '') ? 'inter' : /Instrument/i.test(theme.fonts.sans ?? '') ? 'instrument' : /Georgia|Times/i.test(theme.fonts.sans ?? '') ? 'serif' : /Geist/i.test(theme.fonts.sans ?? '') ? 'geist' : 'system', monoFontId: /JetBrains/i.test(theme.fonts.mono ?? '') ? 'jetbrains' : 'system', customTheme: { baseThemeId, light: mode === 'light' ? colors : {}, dark: mode === 'dark' ? colors : {} } });
}

/** Typography edits are a patch, not a migration of legacy palettes. */
export function updateWebTheme<T extends Parameters<typeof appearanceFromWebTheme>[0]>(theme: T, patch: Partial<AppearancePreferences>, systemDark = false) {
  const appearance = normalizeAppearance({ ...appearanceFromWebTheme(theme), ...patch });
  if (Object.keys(patch).every(key => key === 'fontId' || key === 'monoFontId')) {
    return {
      ...theme,
      ...(theme.appearance ? { appearance } : {}),
      fonts: {
        ...theme.fonts,
        ...(patch.fontId ? { sans: FONT_OPTIONS.find(font => font.id === appearance.fontId)!.family } : {}),
        ...(patch.monoFontId ? { mono: MONO_FONT_OPTIONS.find(font => font.id === appearance.monoFontId)!.family } : {}),
      },
    };
  }
  return { ...theme, ...buildWebTheme(appearance, systemDark) };
}
