"use client";

import { useEffect, useState } from "react";
import {
  PaletteIcon,
  UserIcon,
  MessageSquareIcon,
  SparklesIcon,
  ShieldIcon,
  ClockIcon,
  PuzzleIcon,
  MonitorIcon,
  CableIcon,
} from "lucide-react";
import { AppearanceSection } from "./settings/sections/AppearanceSection";
import { AgentSection } from "./settings/sections/AgentSection";
import { ChannelsSection } from "./settings/sections/ChannelsSection";
import { IntegrationsSection } from "./settings/sections/IntegrationsSection";
import { SkillsSection } from "./settings/sections/SkillsSection";
import { CronSection } from "./settings/sections/CronSection";
import { SecuritySection } from "./settings/sections/SecuritySection";
import { PluginsSection } from "./settings/sections/PluginsSection";
import { SystemSection } from "./settings/sections/SystemSection";


const sections = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "agent", label: "Agent", icon: UserIcon },
  { id: "channels", label: "Channels", icon: MessageSquareIcon },
  { id: "integrations", label: "Integrations", icon: CableIcon },
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
  const [activeSection, setActiveSection] = useState<SectionId>("appearance");

  // Delayed unmount so the exit animation has time to play. `visible`
  // flips one frame after mount so the enter transition has a distinct
  // "from" state to animate out of. Same pattern as VocalPanel.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- delayed mount for enter animation
      setMounted(true);
      const t = setTimeout(() => setVisible(true), 20);
      return () => clearTimeout(t);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(t);
  }, [open]);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset section on close
      setActiveSection("appearance");
    }
  }, [open]);

  if (!mounted) return null;

  const transitionEase = "cubic-bezier(0.22, 1, 0.36, 1)";

  return (
    <div className="fixed inset-0 z-[45]">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-xl"
        style={{
          opacity: visible ? 1 : 0,
          transition: `opacity 300ms ${transitionEase}`,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onOpenChange(false);
        }}
      />

      <div className="relative flex items-center justify-center h-full z-10 overflow-hidden">
        <div
          className="flex flex-col w-[880px] max-w-[92vw] h-[680px] max-h-[88vh] bg-card/95 backdrop-blur-xl rounded-2xl shadow-2xl overflow-hidden"
          style={{
            opacity: visible ? 1 : 0,
            transform: visible ? "scale(1) translateY(0)" : "scale(0.96) translateY(8px)",
            transition: `opacity 320ms ${transitionEase}, transform 320ms ${transitionEase}`,
          }}
        >
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
              {activeSection === "appearance" && <AppearanceSection />}
              {activeSection === "agent" && <AgentSection />}
              {activeSection === "channels" && <ChannelsSection />}
              {activeSection === "integrations" && <IntegrationsSection />}
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
