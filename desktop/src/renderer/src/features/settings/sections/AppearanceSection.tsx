import { useEffect, useState } from "react";
import { Button } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { Card, SectionHeader } from "./section-kit";

type Theme = "dark" | "light" | "system";

export default function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    void invoke("state:get", { key: "appearance" }).then((result) => {
      const value = result.value as { theme?: Theme } | null;
      if (value?.theme) setTheme(value.theme);
    });
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    const resolved = next === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : next;
    document.documentElement.setAttribute("data-theme", resolved);
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
