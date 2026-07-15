import {
  Blocks,
  Clock,
  CreditCard,
  Cpu,
  MonitorCog,
  Palette,
  Server,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import AccountSection from "./sections/AccountSection";
import AppearanceSection from "./sections/AppearanceSection";
import RuntimeSection from "./sections/RuntimeSection";
import AgentSection from "./sections/AgentSection";
import BillingSection from "./sections/BillingSection";
import ChannelsSection from "./sections/ChannelsSection";
import IntegrationsSection from "./sections/IntegrationsSection";
import CronSection from "./sections/CronSection";
import SystemSection from "./sections/SystemSection";
import { invoke } from "../../lib/operator";
import { useUi } from "../../stores/ui";

type SectionId =
  | "account"
  | "appearance"
  | "billing"
  | "runtime"
  | "agent"
  | "channels"
  | "integrations"
  | "cron"
  | "system";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode; group: string }[] = [
  { id: "account", label: "Account", icon: <UserRound size={15} />, group: "You" },
  { id: "billing", label: "Billing", icon: <CreditCard size={15} />, group: "You" },
  { id: "appearance", label: "Appearance", icon: <Palette size={15} />, group: "You" },
  { id: "agent", label: "Agent (Hermes)", icon: <Sparkles size={15} />, group: "Machine" },
  { id: "runtime", label: "Computers", icon: <Server size={15} />, group: "Machine" },
  { id: "channels", label: "Channels", icon: <MonitorCog size={15} />, group: "Machine" },
  { id: "integrations", label: "Integrations", icon: <Blocks size={15} />, group: "Machine" },
  { id: "cron", label: "Schedules", icon: <Clock size={15} />, group: "Machine" },
  { id: "system", label: "System", icon: <Cpu size={15} />, group: "Machine" },
];

function applyDocumentTheme(next: "dark" | "light" | "system") {
  const resolved =
    next === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : next;
  document.documentElement.setAttribute("data-theme", resolved);
}

function isSectionId(value: string): value is SectionId {
  return SECTIONS.some((candidate) => candidate.id === value);
}

export default function SettingsView() {
  const [section, setSection] = useState<SectionId>("account");
  const requestedSection = useUi((s) => s.requestedSettingsSection);

  // Deep links (for example the provider recovery CTA) request a section
  // before opening or focusing the Settings tab; consume it once.
  useEffect(() => {
    if (!requestedSection) return;
    if (isSectionId(requestedSection)) setSection(requestedSection);
    useUi.getState().clearRequestedSettingsSection();
  }, [requestedSection]);

  useEffect(() => {
    void invoke("state:get", { key: "appearance" })
      .then((result) => {
        const value = result.value as { theme?: string } | null;
        if (value?.theme === "light" || value?.theme === "system" || value?.theme === "dark") {
          applyDocumentTheme(value.theme);
        }
      })
      .catch((err: unknown) => {
        console.warn(
          "[settings] load appearance failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }, []);
  const groups = Array.from(new Set(SECTIONS.map((s) => s.group)));

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        className="flex w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <h2 className="px-2.5 py-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          Settings
        </h2>
        {groups.map((group) => (
          <div key={group} className="mb-1 flex flex-col gap-0.5">
            <span className="px-2.5 pt-2 pb-1 text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
              {group}
            </span>
            {SECTIONS.filter((s) => s.group === group).map((s) => {
              const active = s.id === section;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors duration-100"
                  style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)", background: active ? "var(--bg-selected)" : "transparent" }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }}>{s.icon}</span>
                  {s.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-8">
          {section === "account" ? <AccountSection /> : null}
          {section === "billing" ? <BillingSection /> : null}
          {section === "appearance" ? <AppearanceSection /> : null}
          {section === "runtime" ? <RuntimeSection /> : null}
          {section === "agent" ? <AgentSection /> : null}
          {section === "channels" ? <ChannelsSection /> : null}
          {section === "integrations" ? <IntegrationsSection /> : null}
          {section === "cron" ? <CronSection /> : null}
          {section === "system" ? <SystemSection /> : null}
        </div>
      </div>
    </div>
  );
}
