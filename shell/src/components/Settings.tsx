"use client";

import { useEffect, useRef, useState } from "react";
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
  CreditCardIcon,
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
import { BillingSection } from "./settings/sections/BillingSection";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";


const sections = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "agent", label: "Agent", icon: UserIcon },
  { id: "channels", label: "Channels", icon: MessageSquareIcon },
  { id: "integrations", label: "Integrations", icon: CableIcon },
  { id: "skills", label: "Skills", icon: SparklesIcon },
  { id: "security", label: "Security", icon: ShieldIcon },
  { id: "billing", label: "Billing", icon: CreditCardIcon },
  { id: "cron", label: "Cron", icon: ClockIcon },
  { id: "plugins", label: "Plugins", icon: PuzzleIcon },
  { id: "system", label: "System", icon: MonitorIcon },
] as const;

type SectionId = typeof sections[number]["id"];

function TrafficLights({ onClose, closeDisabled = false }: { onClose: () => void; closeDisabled?: boolean }) {
  return (
    <div className="group/traffic flex items-center gap-1.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (closeDisabled) return;
          onClose();
        }}
        className={`size-3 rounded-full bg-[#ff5f57] flex items-center justify-center transition-colors ${
          closeDisabled ? "cursor-not-allowed opacity-45" : "hover:brightness-90"
        }`}
        aria-label="Close"
        disabled={closeDisabled}
      >
        <span className="text-[8px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          x
        </span>
      </button>
      <button
        type="button"
        className="size-3 rounded-full bg-[#febc2e] flex items-center justify-center hover:brightness-90 transition-colors opacity-50 cursor-default"
        aria-label="Minimize"
        disabled
      >
        <span className="text-[9px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          -
        </span>
      </button>
      <button
        type="button"
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
  defaultSection?: SectionId;
  lockedSection?: SectionId;
  billingActiveOverride?: boolean | null;
  closeDisabled?: boolean;
  billingMode?: "settings" | "provisioning";
  onBillingCheckoutIntent?: () => void;
}

export function Settings({
  open,
  onOpenChange,
  defaultSection = "appearance",
  lockedSection,
  billingActiveOverride,
  closeDisabled = false,
  billingMode = "settings",
  onBillingCheckoutIntent,
}: SettingsProps) {
  const [activeSection, setActiveSection] = useState<SectionId>(defaultSection);
  const wasOpenRef = useRef(open);
  const matrixBilling = useMatrixBillingAccess();
  const billingActive =
    billingActiveOverride !== undefined
      ? billingActiveOverride
      : matrixBilling.active;

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
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;

    if (open && lockedSection) {
      setActiveSection(lockedSection);
      return;
    }
    if (justOpened && billingActive === false) {
      setActiveSection("billing");
      return;
    }
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset section on close
      setActiveSection(defaultSection);
    }
  }, [billingActive, defaultSection, lockedSection, open]);

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
          if (!closeDisabled && e.target === e.currentTarget) onOpenChange(false);
        }}
      />

      <div className="relative z-10 flex h-full items-center justify-center overflow-hidden sm:p-4">
        <div
          className="flex h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none bg-card/95 shadow-2xl backdrop-blur-xl sm:h-[90vh] sm:max-h-[90vh] sm:w-[94vw] sm:max-w-[94vw] sm:rounded-2xl xl:h-[760px] xl:w-[1180px]"
          style={{
            opacity: visible ? 1 : 0,
            transform: visible ? "scale(1) translateY(0)" : "scale(0.96) translateY(8px)",
            transition: `opacity 320ms ${transitionEase}, transform 320ms ${transitionEase}`,
          }}
        >
          <header className="flex items-center gap-3 px-4 py-3 border-b border-border/40 select-none">
            <TrafficLights closeDisabled={closeDisabled} onClose={() => onOpenChange(false)} />
            <h1 className="text-xs font-medium text-center flex-1">Settings</h1>
            <div className="w-[42px]" />
          </header>

          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <aside className="w-full shrink-0 border-b border-border/40 bg-card/50 p-2 sm:w-48 sm:border-b-0 sm:border-r sm:overflow-y-auto">
              <nav className="flex gap-1 overflow-x-auto pb-1 sm:flex-col sm:gap-0.5 sm:overflow-x-visible sm:pb-0">
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active = activeSection === section.id;
                  const locked = Boolean(lockedSection && section.id !== lockedSection);
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => {
                        if (!locked) setActiveSection(section.id);
                      }}
                      disabled={locked}
                      aria-label={locked ? `${section.label} Locked until billing is active` : section.label}
                      className={`flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                        active
                          ? "bg-ember/12 text-deep font-semibold"
                          : locked
                            ? "cursor-not-allowed text-muted-foreground/45"
                            : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                      }`}
                    >
                      <Icon
                        className={`size-4 shrink-0 ${
                          active ? "text-ember" : ""
                        }`}
                      />
                      <span>{section.label}</span>
                      {locked && <span className="sr-only">Locked until billing is active</span>}
                    </button>
                  );
                })}
              </nav>
            </aside>

            <main className="min-w-0 flex-1 overflow-y-auto">
              {activeSection === "appearance" && <AppearanceSection />}
              {activeSection === "agent" && <AgentSection />}
              {activeSection === "channels" && <ChannelsSection />}
              {activeSection === "integrations" && <IntegrationsSection />}
              {activeSection === "skills" && <SkillsSection />}
              {activeSection === "cron" && <CronSection />}
              {activeSection === "security" && <SecuritySection />}
              {activeSection === "billing" && (
                <BillingSection
                  mode={billingMode}
                  onCheckoutIntent={onBillingCheckoutIntent}
                />
              )}
              {activeSection === "plugins" && <PluginsSection />}
              {activeSection === "system" && <SystemSection billingActive={billingActive !== false} />}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
