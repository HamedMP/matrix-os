"use client";

import { useEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";

export interface Theme {
  name: string;
  mode?: "light" | "dark";
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: string;
}

export const DEFAULT_THEME: Theme = {
  name: "default",
  colors: {
    background: "#ece5f0",
    foreground: "#1c1917",
    card: "#ffffff",
    "card-foreground": "#1c1917",
    popover: "#ffffff",
    "popover-foreground": "#1c1917",
    primary: "#c2703a",
    "primary-foreground": "#ffffff",
    secondary: "#f0eaf4",
    "secondary-foreground": "#44403c",
    muted: "#f0eaf4",
    "muted-foreground": "#78716c",
    accent: "#f0eaf4",
    "accent-foreground": "#44403c",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
    border: "#d8d0de",
    input: "#d8d0de",
    ring: "#c2703a",
  },
  fonts: {
    mono: "JetBrains Mono, monospace",
    sans: "Inter, system-ui, sans-serif",
  },
  radius: "0.75rem",
};

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

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  // Fetch theme from server on mount
  useEffect(() => {
    fetchTheme().then(setTheme);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useFileWatcher((path, event) => {
    if (path === "system/theme.json" && event !== "unlink") {
      fetchTheme().then(setTheme);
    }
  });

  return theme;
}

export async function saveTheme(theme: Theme): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  await fetch(`${gatewayUrl}/api/settings/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(theme),
  });
}

async function fetchTheme(): Promise<Theme> {
  try {
    const gatewayUrl = getGatewayUrl();
    const res = await fetch(`${gatewayUrl}/api/theme`);
    if (res.ok) return res.json();
  } catch {
    // fall through
  }
  return DEFAULT_THEME;
}
