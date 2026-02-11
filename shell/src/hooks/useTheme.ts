"use client";

import { useEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";

interface Theme {
  name: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: string;
}

const DEFAULT_THEME: Theme = {
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

  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value);
  }

  for (const [key, value] of Object.entries(theme.fonts)) {
    root.style.setProperty(`--font-${key}`, value);
  }

  root.style.setProperty("--radius", theme.radius);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

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

async function fetchTheme(): Promise<Theme> {
  try {
    const gatewayUrl =
      process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";
    const res = await fetch(`${gatewayUrl}/api/theme`);
    if (res.ok) return res.json();
  } catch {
    // fall through
  }
  return DEFAULT_THEME;
}
