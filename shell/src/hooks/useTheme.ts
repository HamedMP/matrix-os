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
    bg: "#0a0a0a",
    fg: "#ededed",
    accent: "#3b82f6",
    surface: "#171717",
    border: "#262626",
    muted: "#737373",
    error: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
  },
  fonts: {
    mono: "JetBrains Mono, monospace",
    sans: "Inter, system-ui, sans-serif",
  },
  radius: "0.5rem",
};

function applyTheme(theme: Theme) {
  const root = document.documentElement;

  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--color-${key}`, value);
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
