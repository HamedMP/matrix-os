import { getThemeVariant, FONT_OPTIONS, MONO_FONT_OPTIONS, RETIRED_THEME_IDS } from './index.js';
import { legacyThemeMode } from './customization.js';
import { themeSemantics } from './semantics.js';
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearancePreferences } from './preferences.js';

/** Compatibility projection for the file-backed Web Canvas/Web Desktop theme. */
export function buildWebTheme(input: AppearancePreferences = DEFAULT_APPEARANCE, systemDark = false) {
  const appearance = normalizeAppearance(input);
  const mode = appearance.mode === 'system' ? systemDark ? 'dark' : 'light' : appearance.mode;
  const { chrome: c } = getThemeVariant(appearance.themeId, mode, appearance.customTheme);
  const semantic = themeSemantics(c);
  return {
    name: appearance.themeId, mode, appearance,
    colors: {
      background: c.background, foreground: c.foreground, card: c.card, 'card-foreground': c.cardForeground,
      popover: c.popover, 'popover-foreground': c.popoverForeground, primary: c.primary, 'primary-foreground': c.primaryForeground,
      secondary: c.secondary, 'secondary-foreground': c.secondaryForeground, muted: c.muted, 'muted-foreground': c.mutedForeground,
      accent: c.accent, 'accent-foreground': c.accentForeground,
      'primary-hover': semantic.primaryHover, 'primary-hover-foreground': semantic.primaryHoverForeground,
      destructive: semantic.danger, 'destructive-foreground': semantic.dangerForeground, 'destructive-text': semantic.dangerText,
      success: semantic.success, 'success-foreground': semantic.successForeground, 'success-text': semantic.successText,
      warning: semantic.warning, 'warning-foreground': semantic.warningForeground, 'warning-text': semantic.warningText,
      info: semantic.info, 'info-foreground': semantic.infoForeground, 'info-text': semantic.infoText,
      'tint-success-fill': semantic.successMuted, 'tint-warning-fill': semantic.warningMuted,
      'tint-destructive-fill': semantic.dangerMuted, 'tint-info-fill': semantic.infoMuted,
      'chart-1': c.chart1, 'chart-2': c.chart2, 'chart-3': c.chart3, 'chart-4': c.chart4, 'chart-5': c.chart5,
      border: c.border, input: c.input, ring: c.ring,
      sidebar: c.sidebar, 'sidebar-foreground': c.sidebarForeground,
      'sidebar-primary': c.sidebarPrimary, 'sidebar-primary-foreground': c.sidebarPrimaryForeground,
      'sidebar-accent': c.sidebarAccent, 'sidebar-accent-foreground': c.sidebarAccentForeground,
      'sidebar-border': c.sidebarBorder, 'sidebar-ring': c.sidebarRing,
    },
    fonts: { sans: FONT_OPTIONS.find(f => f.id === appearance.fontId)!.family, mono: MONO_FONT_OPTIONS.find(f => f.id === appearance.monoFontId)!.family },
    radius: '0.5rem',
  };
}

/** Preserve older file themes when opening the new controls or changing a font. */
export function appearanceFromWebTheme(theme: { name: string; mode?: 'light' | 'dark'; colors: Record<string, string>; fonts: Record<string, string>; appearance?: AppearancePreferences }): AppearancePreferences {
  if (theme.appearance) return normalizeAppearance(theme.appearance);
  const mode = theme.mode ?? legacyThemeMode(theme.colors.background ?? '#ffffff');
  if ((RETIRED_THEME_IDS as readonly string[]).includes(theme.name)) return normalizeAppearance({ mode });
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
