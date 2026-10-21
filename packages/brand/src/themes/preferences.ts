import { FONT_OPTIONS, MONO_FONT_OPTIONS, normalizeCustomTheme, type FontId, type MonoFontId, type CustomTheme } from './customization.js';
import { isThemeId } from './index.js';
export interface AppearancePreferences {
  mode: 'light' | 'dark' | 'system'; themeId: string; fontId: FontId; monoFontId: MonoFontId; customTheme: CustomTheme | null;
}
export const DEFAULT_APPEARANCE: AppearancePreferences = { mode: 'light', themeId: 'matrix', fontId: 'geist', monoFontId: 'jetbrains', customTheme: null };
export function normalizeAppearance(value: unknown): AppearancePreferences {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const customTheme = normalizeCustomTheme(v.customTheme);
  if (customTheme && (!isThemeId(customTheme.baseThemeId) || customTheme.baseThemeId === 'custom')) customTheme.baseThemeId = 'matrix';
  return {
    mode: v.mode === 'dark' || v.mode === 'system' ? v.mode : 'light',
    themeId: isThemeId(v.themeId) && (v.themeId !== 'custom' || customTheme) ? v.themeId : 'matrix',
    fontId: FONT_OPTIONS.find(f => f.id === v.fontId)?.id ?? 'geist',
    monoFontId: MONO_FONT_OPTIONS.find(f => f.id === v.monoFontId)?.id ?? 'jetbrains',
    customTheme,
  };
}
