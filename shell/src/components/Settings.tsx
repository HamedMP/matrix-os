"use client";

import { useEffect, useEffectEvent, useState } from "react";
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
import type { ComputerSetupSelection } from "./settings/sections/BillingPanel";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import { UserButton as AccountButton } from "./UserButton";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
import { useThemeStyle } from "./window/useThemeStyle";
import {
  designTitleBarContainerStyle,
  resolveTitleBarVariant,
  usesCaptionButtons,
} from "./window/title-bar-variant";
import { DesignCaptionButtons } from "./window/DesignCaptionButtons";


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

// Sections temporarily hidden from the Settings nav for the paid-beta scope.
// The section components and render branches below are intentionally kept so a
// section can be re-enabled by removing its id here. See AGENTS.md "Deferred work".
const HIDDEN_SECTION_IDS = new Set<SectionId>([
  "agent",
  "channels",
  "skills",
  "security",
  "cron",
  "plugins",
]);
const visibleSections = sections.filter((section) => !HIDDEN_SECTION_IDS.has(section.id));

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

function SettingsAccountFooter() {
  return (
    <section
      aria-label="Account"
      className="sticky bottom-0 z-10 mt-2 flex shrink-0 items-center border-t border-border/40 bg-card/95 px-2 py-2 backdrop-blur sm:static sm:mt-auto sm:bg-transparent sm:px-0 sm:pt-3 sm:backdrop-blur-none"
    >
      <AccountButton variant="settings" />
    </section>
  );
}

interface SettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSection?: SectionId;
  lockedSection?: SectionId;
  billingActiveOverride?: boolean | null;
  closeDisabled?: boolean;
  billingMode?: "settings" | "provisioning" | "device-setup" | "add-computer";
  onBillingCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onBillingCheckoutNavigate?: (url: string) => void;
  billingCheckoutReturnPath?: string;
  billingCheckoutRuntimeSlot?: string;
}

export function Settings({
  ...props
}: SettingsProps) {
  if (isSelfHostedRuntime()) {
    return <SettingsFrame {...props} billingActive={true} showBillingSection={false} />;
  }
  return <ManagedSettings {...props} />;
}

function ManagedSettings(props: SettingsProps) {
  const matrixBilling = useMatrixBillingAccess();
  const billingActive =
    props.billingActiveOverride !== undefined
      ? props.billingActiveOverride
      : matrixBilling.active;

  return <SettingsFrame {...props} billingActive={billingActive} showBillingSection />;
}

interface SettingsFrameProps extends SettingsProps {
  billingActive: boolean | null;
  showBillingSection: boolean;
}

function SettingsFrame({
  open,
  onOpenChange,
  defaultSection = "appearance",
  lockedSection,
  closeDisabled = false,
  billingMode = "settings",
  onBillingCheckoutIntent,
  onBillingCheckoutNavigate,
  billingCheckoutReturnPath,
  billingCheckoutRuntimeSlot,
  billingActive,
  showBillingSection,
}: SettingsFrameProps) {
  const resolvedDefaultSection = !showBillingSection && defaultSection === "billing" ? "appearance" : defaultSection;
  const resolvedLockedSection = !showBillingSection && lockedSection === "billing" ? undefined : lockedSection;
  const frameVisibleSections = showBillingSection
    ? visibleSections
    : visibleSections.filter((section) => section.id !== "billing");
  const [activeSection, setActiveSection] = useState<SectionId>(resolvedDefaultSection);
  // Tracks the prior `open` value so the render-time section adjustment below
  // can detect the open transition. Uses the React-documented "store previous
  // prop in state" pattern (state, not a ref): reading/writing a ref during
  // render is exactly what React Compiler cannot optimize, whereas a guarded
  // setState during render is the supported pattern.
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- transition tracker, not a mirror of `open`: it stores the previous `open` value so the render-time section adjustment below can detect the open->close edge
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- intentionally state, not a ref: it IS read during render (in `justOpened` below) to drive the adjustment; the rule's "use useRef" advice would force ref reads/writes during render, which React Compiler flags as unoptimizable
  const [prevOpen, setPrevOpen] = useState(open);
  // Delayed unmount so the exit animation has time to play. `visible`
  // flips one frame after mount so the enter transition has a distinct
  // "from" state to animate out of. Same pattern as VocalPanel.
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- not a mirror of `open`: `mounted` stays true through the ~320ms exit window after `open` flips to false so the close animation can play, then unmounts via the timer below
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const themeStyle = useThemeStyle();

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- delayed-unmount animation primitive: mount immediately on open, defer visible/unmount via timers so the enter/exit transitions can play; these setStates are timer-sequenced, not a cascade
  useEffect(() => {
    if (open) {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount synchronously when opened so the panel exists before the enter transition; cannot be derived because the exit window is timer-driven
      setMounted(true);
      const t = setTimeout(() => setVisible(true), 20);
      return () => clearTimeout(t);
    }
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- delayed-unmount animation primitive: when `open` flips false we start the fade-out by clearing `visible` here, then unmount via the timer below; the visible/mounted split is intentional, not duplicated prop state
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(t);
  }, [open]);

  const onEscape = useEffectEvent(() => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onEscape();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Adjust the active section during render (not in an effect) when the
  // relevant props change. Doing this in render avoids the extra commit with
  // stale UI that an effect would cause. Each branch is guarded by an equality
  // check so the setState only fires on an actual transition, never looping.
  // `activeSection` is still genuine interactive state — the nav buttons mutate
  // it — so it cannot be a pure render-time derivation.
  const justOpened = open && !prevOpen;
  if (open !== prevOpen) setPrevOpen(open);
  if (open && resolvedLockedSection) {
    if (activeSection !== resolvedLockedSection) setActiveSection(resolvedLockedSection);
  } else if (justOpened && showBillingSection && billingActive === false) {
    if (activeSection !== "billing") setActiveSection("billing");
  } else if (!open) {
    if (activeSection !== resolvedDefaultSection) setActiveSection(resolvedDefaultSection);
  }

  if (!mounted) return null;

  const titleBarVariant = resolveTitleBarVariant(themeStyle);
  const transitionEase = "cubic-bezier(0.22, 1, 0.36, 1)";
  return (
    <div className="fixed inset-0" style={{ zIndex: SHELL_Z_INDEX.settings }}>
      <button
        type="button"
        aria-label="Close settings"
        disabled={closeDisabled}
        className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-xl"
        style={{
          opacity: visible ? 1 : 0,
          transition: `opacity 300ms ${transitionEase}`,
        }}
        onClick={(e) => {
          if (!closeDisabled && e.target === e.currentTarget) onOpenChange(false);
        }}
      />

      <div className="pointer-events-none relative z-10 flex h-full items-center justify-center overflow-hidden sm:p-4">
        <div
          className="pointer-events-auto flex h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none bg-card/95 shadow-2xl backdrop-blur-xl sm:h-[90vh] sm:max-h-[90vh] sm:w-[94vw] sm:max-w-[94vw] sm:rounded-2xl xl:h-[760px] xl:w-[1180px]"
          style={{
            opacity: visible ? 1 : 0,
            transform: visible ? "scale(1) translateY(0)" : "scale(0.96) translateY(8px)",
            transition: `opacity 320ms ${transitionEase}, transform 320ms ${transitionEase}`,
          }}
        >
          <header
            className="flex items-center gap-3 px-4 py-3 border-b border-border/40 select-none"
            style={designTitleBarContainerStyle(titleBarVariant)}
          >
            {usesCaptionButtons(titleBarVariant) ? (
              <>
                <h1 className="text-xs font-medium flex-1">Settings</h1>
                <DesignCaptionButtons
                  variant={titleBarVariant}
                  onClose={() => onOpenChange(false)}
                  closeDisabled={closeDisabled}
                />
              </>
            ) : (
              <>
                <TrafficLights closeDisabled={closeDisabled} onClose={() => onOpenChange(false)} />
                <h1 className="text-xs font-medium text-center flex-1">Settings</h1>
                <div className="w-[42px]" />
              </>
            )}
          </header>

          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <aside className="flex w-full shrink-0 flex-col border-b border-border/40 bg-card/50 p-2 sm:w-52 sm:border-b-0 sm:border-r">
              <nav
                aria-label="Settings sections"
                className="flex gap-1 overflow-x-auto pb-1 sm:min-h-0 sm:flex-1 sm:flex-col sm:gap-0.5 sm:overflow-x-visible sm:overflow-y-auto sm:pb-0"
              >
                {frameVisibleSections.map((section) => {
                  const Icon = section.icon;
                  const active = activeSection === section.id;
                  const locked = Boolean(resolvedLockedSection && section.id !== resolvedLockedSection);
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => {
                        if (!locked) setActiveSection(section.id);
                      }}
                      disabled={locked}
                      aria-label={locked ? `${section.label} Locked until billing is active` : section.label}
                      className={`flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2.5 text-[13px] transition-colors sm:px-2.5 sm:py-1.5 ${
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
              <SettingsAccountFooter />
            </aside>

            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              {activeSection === "appearance" && <AppearanceSection />}
              {activeSection === "agent" && <AgentSection />}
              {activeSection === "channels" && <ChannelsSection />}
              {activeSection === "integrations" && <IntegrationsSection />}
              {activeSection === "skills" && <SkillsSection />}
              {activeSection === "cron" && <CronSection />}
              {activeSection === "security" && <SecuritySection />}
              {showBillingSection && activeSection === "billing" && (
                <BillingSection
                  mode={billingMode}
                  onCheckoutIntent={onBillingCheckoutIntent}
                  onCheckoutNavigate={onBillingCheckoutNavigate}
                  checkoutReturnPath={billingCheckoutReturnPath}
                  checkoutRuntimeSlot={billingCheckoutRuntimeSlot}
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
