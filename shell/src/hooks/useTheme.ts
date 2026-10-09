"use client";

import { legacyThemeMode } from "@matrix-os/brand/themes/customization";
import { RETIRED_THEME_IDS } from "@matrix-os/brand/themes";
import { buildWebTheme } from "@matrix-os/brand/themes/web-theme";
import { normalizeAppearance, type AppearancePreferences } from "@matrix-os/brand/themes/preferences";
import { useEffect, useRef, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";
import {
  loadShellSnapshot,
  saveShellSnapshot,
  type ShellSnapshotScope,
} from "@/lib/shell-snapshot-cache";

export interface Theme {
  name: string;
  appearance?: AppearancePreferences;
  mode?: "light" | "dark";
  style?: "flat" | "neumorphic" | "macos-glass" | "winxp" | "win11";
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: string;
}

export const DEFAULT_THEME: Theme = buildWebTheme();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEntries(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function normalizeTheme(value: unknown, fallbackTheme: Theme = DEFAULT_THEME): Theme {
  if (!isRecord(value)) return fallbackTheme;
  if (Object.keys(value).length === 0) return fallbackTheme;

  if (typeof value.name === 'string' && (RETIRED_THEME_IDS as readonly string[]).includes(value.name) && !value.appearance) {
    const mode = value.mode === 'light' || value.mode === 'dark' ? value.mode : legacyThemeMode(String(stringEntries(value.colors).background ?? '#ffffff'));
    return buildWebTheme({ ...normalizeAppearance({}), mode });
  }
  const colors = { ...fallbackTheme.colors, ...stringEntries(value.colors) };
  const savedColors = stringEntries(value.colors);
  // Older files used general chrome tokens for navigation.
  for (const [key, fallback] of Object.entries({ sidebar: 'secondary', 'sidebar-foreground': 'foreground', 'sidebar-primary': 'primary', 'sidebar-primary-foreground': 'primary-foreground', 'sidebar-accent': 'accent', 'sidebar-accent-foreground': 'accent-foreground', 'sidebar-border': 'border', 'sidebar-ring': 'ring' })) {
    if (!savedColors[key]) colors[key] = colors[fallback]!;
  }
  return {
    ...(isRecord(value.appearance) ? { appearance: normalizeAppearance(value.appearance) } : {}),
    name: typeof value.name === "string" && value.name.trim() ? value.name : fallbackTheme.name,
    ...(value.mode === "light" || value.mode === "dark" ? { mode: value.mode } : {}),
    ...(value.style === "flat" ||
      value.style === "neumorphic" ||
      value.style === "macos-glass" ||
      value.style === "winxp" ||
      value.style === "win11"
      ? { style: value.style }
      : fallbackTheme.style
        ? { style: fallbackTheme.style }
        : {}),
    colors,
    fonts: {
      ...fallbackTheme.fonts,
      ...stringEntries(value.fonts),
    },
    radius: typeof value.radius === "string" && value.radius.trim() ? value.radius : fallbackTheme.radius,
  };
}

function applyTheme(saved: Theme) {
  const derived = saved.appearance ? buildWebTheme(saved.appearance, window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false) : null;
  const theme = derived ? { ...saved, ...derived, colors: { ...saved.colors, ...derived.colors }, fonts: { ...saved.fonts, ...derived.fonts } } : saved;
  const root = document.documentElement;

  // Set mode attribute so CSS and apps can detect light/dark
  const mode = theme.mode ?? inferMode(theme);
  root.setAttribute("data-theme", mode);
  if (mode === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }

  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value);
  }

  for (const [key, value] of Object.entries(theme.fonts)) {
    root.style.setProperty(`--font-${key}`, value);
  }

  root.style.setProperty("--radius", theme.radius);

  // Set theme style attribute for CSS design-system overrides
  root.setAttribute("data-theme-style", theme.style ?? "flat");
}

/** Infer light/dark mode from the background color luminance */
function inferMode(theme: Theme): "light" | "dark" {
  return legacyThemeMode(theme.colors.background ?? '#ffffff');
}

export function getThemeFallback(): Theme {
  // First-run shell fallback stays light. Terminal readability is handled by
  // terminal-specific settings, not by changing global shell theme tokens.
  return DEFAULT_THEME;
}

export interface ShellCacheHookOptions {
  cacheScope?: ShellSnapshotScope | null;
}

interface ThemeRuntimeCache {
  gatewayUrl: string;
  theme: Theme;
}

let themeRuntimeCache: ThemeRuntimeCache | null = null;

function rememberTheme(gatewayUrl: string, theme: Theme): void {
  themeRuntimeCache = { gatewayUrl, theme };
}

function initialTheme(
  cacheScope: ShellSnapshotScope | null,
  fallbackTheme: Theme,
  gatewayUrl: string,
): Theme {
  // A scoped root never borrows another user's/runtime's module snapshot.
  // Nested consumers without a scope may reuse only the current gateway's
  // already-applied value, avoiding a transient reset to the default design.
  if (cacheScope) {
    return normalizeTheme(loadShellSnapshot(cacheScope)?.theme, fallbackTheme);
  }
  return themeRuntimeCache?.gatewayUrl === gatewayUrl
    ? themeRuntimeCache.theme
    : fallbackTheme;
}

export function useThemeState(options: ShellCacheHookOptions = {}) {
  const fallbackTheme = getThemeFallback();
  const cacheScope = options.cacheScope ?? null;
  const cacheKey = cacheScope?.storageKey;
  const gatewayUrl = getGatewayUrl();
  const requestVersion = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => initialTheme(cacheScope, fallbackTheme, gatewayUrl));

  useEffect(() => {
    if (!cacheScope) return;
    const cachedTheme = loadShellSnapshot(cacheScope)?.theme;
    if (cachedTheme) setTheme(normalizeTheme(cachedTheme, fallbackTheme));
  }, [cacheKey, cacheScope, fallbackTheme]);

  // Fetch theme from server on mount
  useEffect(() => {
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setLoaded(false);
    setLoadError(false);
    fetchTheme(fallbackTheme, controller.signal, (ok) => {
      if (!controller.signal.aborted && version === requestVersion.current) { setLoaded(ok); setLoadError(!ok); }
    }).then((nextTheme) => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setTheme(nextTheme);
      saveShellSnapshot(cacheScope, { theme: nextTheme });
    });

    return () => controller.abort();
  }, [fallbackTheme, cacheKey, cacheScope, gatewayUrl]);

  useEffect(() => {
    rememberTheme(gatewayUrl, theme);
    applyTheme(theme);
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const updateMode = () => { if (theme.appearance?.mode === "system") applyTheme(theme); };
    media?.addEventListener?.("change", updateMode);
    return () => media?.removeEventListener?.("change", updateMode);
  }, [gatewayUrl, theme]);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ gatewayUrl: string; theme: Theme }>).detail;
      if (detail.gatewayUrl !== gatewayUrl) return;
      requestVersion.current++;
      setLoaded(true); setLoadError(false);
      setTheme(detail.theme);
      saveShellSnapshot(cacheScope, { theme: detail.theme });
    };
    window.addEventListener("matrix-theme-saved", update);
    return () => window.removeEventListener("matrix-theme-saved", update);
  }, [gatewayUrl, cacheScope]);

  useFileWatcher((path, event) => {
    if (path === "system/theme.json" && event !== "unlink") {
      const version = ++requestVersion.current;
      fetchTheme(fallbackTheme, undefined, (ok) => {
        if (version === requestVersion.current) { setLoaded(ok); setLoadError(!ok); }
      }).then((nextTheme) => {
        if (version !== requestVersion.current) return;
        setTheme(nextTheme);
        saveShellSnapshot(cacheScope, { theme: nextTheme });
      });
    }
  });

  return { theme, loaded, loadError };
}

export function useTheme(options: ShellCacheHookOptions = {}) {
  return useThemeState(options).theme;
}

export function saveTheme(theme: Theme): Promise<void>;
export function saveTheme(theme: Theme, options: ShellCacheHookOptions): Promise<void>;
export async function saveTheme(
  theme: Theme,
  options: ShellCacheHookOptions = {},
): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  const res = await fetch(`${gatewayUrl}/api/settings/theme`, {
    signal: AbortSignal.timeout(10_000),
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(theme),
  });
  if (!res.ok) {
    throw new Error("Failed to save theme");
  }
  saveShellSnapshot(options.cacheScope, { theme });
  rememberTheme(gatewayUrl, theme);
  if (typeof document !== "undefined") {
    applyTheme(theme);
    window.dispatchEvent(new CustomEvent("matrix-theme-saved", { detail: { gatewayUrl, theme } }));
  }
}

/** Test hook: clear the module-local current-runtime theme snapshot. */
export function resetThemeRuntimeCacheForTests(): void {
  themeRuntimeCache = null;
}

function settingsFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function fetchTheme(defaultTheme: Theme = DEFAULT_THEME, signal?: AbortSignal, onRead?: (ok: boolean) => void): Promise<Theme> {
  try {
    const gatewayUrl = getGatewayUrl();
    const res = await fetch(`${gatewayUrl}/api/settings/theme`, {
      signal: settingsFetchSignal(signal),
    });
    if (res.ok) {
      const theme = normalizeTheme(await res.json(), defaultTheme);
      onRead?.(true);
      return theme;
    }
  } catch (err: unknown) {
    if (signal?.aborted) return defaultTheme;
    console.warn("[theme] Failed to fetch theme:", err instanceof Error ? err.message : String(err));
  }
  onRead?.(false);
  return defaultTheme;
}
