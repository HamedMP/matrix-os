"use client";

import { useState } from "react";
import { ThemeEditor } from "../ThemeEditor";
import { BackgroundEditor } from "../BackgroundEditor";
import { DockEditor } from "../DockEditor";

const TABS = [
  { id: "theme", label: "Theme" },
  { id: "background", label: "Background" },
  { id: "dock", label: "Dock" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AppearanceSection() {
  const [activeTab, setActiveTab] = useState<TabId>("theme");

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">Appearance</h2>

      <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
              activeTab === tab.id
                ? "bg-background text-foreground font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "theme" && <ThemeEditor />}
      {activeTab === "background" && <BackgroundEditor />}
      {activeTab === "dock" && <DockEditor />}
    </div>
  );
}
