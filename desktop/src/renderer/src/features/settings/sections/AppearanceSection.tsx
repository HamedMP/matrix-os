import { useEffect, useState } from "react";
import { Button } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { Card, SectionHeader } from "./section-kit";

type Theme = "dark" | "light" | "system";

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeToDocument(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(theme));
}

export default function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    void invoke("state:get", { key: "appearance" })
      .then((result) => {
        const value = result.value as { theme?: unknown } | null;
        if (isTheme(value?.theme)) {
          setTheme(value.theme);
          applyThemeToDocument(value.theme);
        }
      })
      .catch((err: unknown) => {
        console.warn(
          "[settings] load appearance failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    applyThemeToDocument(next);
    void invoke("state:set", { key: "appearance", value: { theme: next } }).catch((err: unknown) => {
      console.warn("[settings] persist appearance failed:", err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <>
      <SectionHeader title="Appearance" description="How Matrix OS looks on this machine." />
      <Card>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Theme</span>
        <div className="flex gap-2">
          {(["light", "dark", "system"] as const).map((option) => (
            <Button key={option} variant={theme === option ? "primary" : "subtle"} onClick={() => apply(option)}>
              {option[0]?.toUpperCase()}{option.slice(1)}
            </Button>
          ))}
        </div>
      </Card>
    </>
  );
}
