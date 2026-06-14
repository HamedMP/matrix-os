"use client";

import { useEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";

export interface Theme {
  name: string;
  mode?: "light" | "dark";
  style?: "flat" | "neumorphic";
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: string;
}

export const DEFAULT_THEME: Theme = {
  name: "default",
  colors: {
    background: "#FAFAF9",
    foreground: "#1c1917",
    card: "#FAFAF9",
    "card-foreground": "#1c1917",
    popover: "#FAFAF9",
    "popover-foreground": "#1c1917",
    primary: "#9AA48C",
    "primary-foreground": "#1a1f18",
    secondary: "#f5f5f4",
    "secondary-foreground": "#3c4044",
    muted: "#f5f5f4",
    "muted-foreground": "#6c7178",
    accent: "#f5f5f4",
    "accent-foreground": "#3c4044",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
    border: "#e5e5e4",
    input: "#e5e5e4",
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
    ...(value.style === "flat" || value.style === "neumorphic"
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

  // Set theme style attribute for CSS neumorphic overrides
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

export function useTheme() {
  const fallbackTheme = getThemeFallback();
  const [theme, setTheme] = useState<Theme>(fallbackTheme);

  // Fetch theme from server on mount
  useEffect(() => {
    fetchTheme(fallbackTheme).then(setTheme);
  }, [fallbackTheme]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useFileWatcher((path, event) => {
    if (path === "system/theme.json" && event !== "unlink") {
      fetchTheme(fallbackTheme).then(setTheme);
    }
  });

  return theme;
}

export async function saveTheme(theme: Theme): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  await fetch(`${gatewayUrl}/api/settings/theme`, {
    signal: AbortSignal.timeout(10_000),
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(theme),
  });
}

async function fetchTheme(defaultTheme: Theme = DEFAULT_THEME): Promise<Theme> {
  try {
    const gatewayUrl = getGatewayUrl();
    const res = await fetch(`${gatewayUrl}/api/settings/theme`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return normalizeTheme(await res.json(), defaultTheme);
  } catch (err: unknown) {
    console.warn("[theme] Failed to fetch theme:", err instanceof Error ? err.message : String(err));
  }
  return defaultTheme;
}
