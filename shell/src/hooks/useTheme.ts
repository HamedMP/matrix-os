"use client";

import { useEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";
import {
  loadShellSnapshot,
  saveShellSnapshot,
  type ShellSnapshotScope,
} from "@/lib/shell-snapshot-cache";

export interface Theme {
  name: string;
  mode?: "light" | "dark";
  style?: "flat" | "neumorphic" | "macos-glass" | "winxp" | "win11";
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: string;
}

export const DEFAULT_THEME: Theme = {
  name: "default",
  colors: {
    background: "#FAFAF9",
    foreground: "#32352E",
    card: "#FCFCF8",
    "card-foreground": "#32352E",
    popover: "#FCFCF8",
    "popover-foreground": "#32352E",
    primary: "#434E3F",
    "primary-foreground": "#FAFAF5",
    secondary: "#F1F0E3",
    "secondary-foreground": "#3E4339",
    muted: "#E1E1D0",
    "muted-foreground": "#747668",
    accent: "#F1F0E3",
    "accent-foreground": "#3E4339",
    destructive: "#D74A3A",
    success: "#3A7D44",
    warning: "#E0A12E",
    border: "#D8D6C7",
    input: "#D8D6C7",
    ring: "#D06F25",
  },
  fonts: {
    mono: "JetBrains Mono, monospace",
    sans: "Inter, system-ui, sans-serif",
  },
  radius: "0.75rem",
};

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

  return {
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
    colors: {
      ...fallbackTheme.colors,
      ...stringEntries(value.colors),
    },
    fonts: {
      ...fallbackTheme.fonts,
      ...stringEntries(value.fonts),
    },
    radius: typeof value.radius === "string" && value.radius.trim() ? value.radius : fallbackTheme.radius,
  };
}

function applyTheme(theme: Theme) {
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
  const bg = theme.colors.background || "#ffffff";
  const hex = bg.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  // Relative luminance approximation
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

export function getThemeFallback(): Theme {
  // First-run shell fallback stays light. Terminal readability is handled by
  // terminal-specific settings, not by changing global shell theme tokens.
  return DEFAULT_THEME;
}

export interface ShellCacheHookOptions {
  cacheScope?: ShellSnapshotScope | null;
}

export function useTheme(options: ShellCacheHookOptions = {}) {
  const fallbackTheme = getThemeFallback();
  const cacheScope = options.cacheScope ?? null;
  const cacheKey = cacheScope?.storageKey;
  const [theme, setTheme] = useState<Theme>(() => (
    cacheScope ? normalizeTheme(loadShellSnapshot(cacheScope)?.theme, fallbackTheme) : fallbackTheme
  ));

  useEffect(() => {
    if (!cacheScope) return;
    const cachedTheme = loadShellSnapshot(cacheScope)?.theme;
    if (cachedTheme) setTheme(normalizeTheme(cachedTheme, fallbackTheme));
  }, [cacheKey, cacheScope, fallbackTheme]);

  // Fetch theme from server on mount
  useEffect(() => {
    const controller = new AbortController();
    fetchTheme(fallbackTheme, controller.signal).then((nextTheme) => {
      if (controller.signal.aborted) return;
      setTheme(nextTheme);
      saveShellSnapshot(cacheScope, { theme: nextTheme });
    });

    return () => controller.abort();
  }, [fallbackTheme, cacheKey, cacheScope]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useFileWatcher((path, event) => {
    if (path === "system/theme.json" && event !== "unlink") {
      fetchTheme(fallbackTheme).then((nextTheme) => {
        setTheme(nextTheme);
        saveShellSnapshot(cacheScope, { theme: nextTheme });
      });
    }
  });

  return theme;
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
  if (typeof document !== "undefined") {
    applyTheme(theme);
  }
}

function settingsFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function fetchTheme(defaultTheme: Theme = DEFAULT_THEME, signal?: AbortSignal): Promise<Theme> {
  try {
    const gatewayUrl = getGatewayUrl();
    const res = await fetch(`${gatewayUrl}/api/settings/theme`, {
      signal: settingsFetchSignal(signal),
    });
    if (res.ok) return normalizeTheme(await res.json(), defaultTheme);
  } catch (err: unknown) {
    if (signal?.aborted) return defaultTheme;
    console.warn("[theme] Failed to fetch theme:", err instanceof Error ? err.message : String(err));
  }
  return defaultTheme;
}
