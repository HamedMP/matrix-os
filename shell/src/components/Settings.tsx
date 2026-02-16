"use client";

import { useEffect, useState } from "react";
import {
  UserIcon,
  MessageSquareIcon,
  SparklesIcon,
  ShieldIcon,
  ClockIcon,
  PuzzleIcon,
  MonitorIcon,
} from "lucide-react";
import { AgentSection } from "./settings/sections/AgentSection";
import { ChannelsSection } from "./settings/sections/ChannelsSection";
import { SkillsSection } from "./settings/sections/SkillsSection";
import { CronSection } from "./settings/sections/CronSection";
import { SecuritySection } from "./settings/sections/SecuritySection";
import { PluginsSection } from "./settings/sections/PluginsSection";
import { SystemSection } from "./settings/sections/SystemSection";

const sections = [
  { id: "agent", label: "Agent", icon: UserIcon },
  { id: "channels", label: "Channels", icon: MessageSquareIcon },
  { id: "skills", label: "Skills", icon: SparklesIcon },
  { id: "security", label: "Security", icon: ShieldIcon },
  { id: "cron", label: "Cron", icon: ClockIcon },
  { id: "plugins", label: "Plugins", icon: PuzzleIcon },
  { id: "system", label: "System", icon: MonitorIcon },
] as const;

type SectionId = typeof sections[number]["id"];

function TrafficLights({ onClose }: { onClose: () => void }) {
  return (
    <div className="group/traffic flex items-center gap-1.5">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="size-3 rounded-full bg-[#ff5f57] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Close"
      >
        <span className="text-[8px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          x
        </span>
      </button>
      <button
        className="size-3 rounded-full bg-[#febc2e] flex items-center justify-center hover:brightness-90 transition-colors opacity-50 cursor-default"
        aria-label="Minimize"
        disabled
      >
        <span className="text-[9px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          -
        </span>
      </button>
      <button
        className="size-3 rounded-full bg-[#28c840] flex items-center justify-center hover:brightness-90 transition-colors opacity-50 cursor-default"
        aria-label="Maximize"
        disabled
      />
    </div>
  );
}

interface SettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function Settings({ open, onOpenChange }: SettingsProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("agent");

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) {
      setActiveSection("agent");
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[45]">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-lg"
        onClick={(e) => {
          if (e.target === e.currentTarget) onOpenChange(false);
        }}
      />

      <div className="relative flex h-full z-10 overflow-hidden md:pl-14">
        <div className="flex flex-col flex-1 bg-card/95 backdrop-blur-xl m-4 md:m-8 rounded-2xl shadow-2xl overflow-hidden">
          <header className="flex items-center gap-3 px-4 py-3 border-b border-border/40 select-none">
            <TrafficLights onClose={() => onOpenChange(false)} />
            <h1 className="text-xs font-medium text-center flex-1">Settings</h1>
            <div className="w-[42px]" />
          </header>

          <div className="flex flex-1 min-h-0">
            <aside className="w-48 border-r border-border/40 bg-card/50 p-2 overflow-y-auto">
              <nav className="flex flex-col gap-0.5">
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active = activeSection === section.id;
                  return (
                    <button
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                        active
                          ? "bg-foreground/8 text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                      }`}
                    >
                      <Icon className={`size-4 shrink-0 ${active ? "text-primary" : ""}`} />
                      <span>{section.label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <main className="flex-1 overflow-y-auto">
              {activeSection === "agent" && <AgentSection />}
              {activeSection === "channels" && <ChannelsSection />}
              {activeSection === "skills" && <SkillsSection />}
              {activeSection === "cron" && <CronSection />}
              {activeSection === "security" && <SecuritySection />}
              {activeSection === "plugins" && <PluginsSection />}
              {activeSection === "system" && <SystemSection />}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
