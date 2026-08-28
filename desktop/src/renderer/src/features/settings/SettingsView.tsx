import {
  Blocks,
  Bot,
  Clock,
  CreditCard,
  Cpu,
  Palette,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  UserRound,
} from "@renderer/lib/hugeicons";
import { useEffect, useState } from "react";
import AccountSection from "./sections/AccountSection";
import AppearanceSection from "./sections/AppearanceSection";
import RuntimeSection from "./sections/RuntimeSection";
import AgentSection from "./sections/AgentSection";
import BillingSection from "./sections/BillingSection";
import { IntegrationsSettingsSection } from "../integrations/IntegrationsSettingsSection";
import CronSection from "./sections/CronSection";
import ProvidersSection from "./sections/ProvidersSection";
import SystemSection from "./sections/SystemSection";
import { useUi } from "../../stores/ui";

export type SettingsSectionId =
  | "account"
  | "appearance"
  | "billing"
  | "runtime"
  | "agent"
  | "providers"
  | "integrations"
  | "cron"
  | "system";

const SECTIONS: { id: SettingsSectionId; label: string; icon: React.ReactNode; group: string }[] = [
  { id: "account", label: "Account", icon: <UserRound size={15} />, group: "You" },
  { id: "billing", label: "Billing", icon: <CreditCard size={15} />, group: "You" },
  { id: "appearance", label: "Appearance", icon: <Palette size={15} />, group: "You" },
  { id: "agent", label: "Agent (Hermes)", icon: <Sparkles size={15} />, group: "Machine" },
  { id: "providers", label: "Providers", icon: <Bot size={15} />, group: "Machine" },
  { id: "runtime", label: "Computers", icon: <Server size={15} />, group: "Machine" },
  { id: "integrations", label: "Integrations", icon: <Blocks size={15} />, group: "Machine" },
  { id: "cron", label: "Schedules", icon: <Clock size={15} />, group: "Machine" },
  { id: "system", label: "System", icon: <Cpu size={15} />, group: "Machine" },
];

const SECTIONS_BY_GROUP = SECTIONS.reduce<Record<string, typeof SECTIONS>>((grouped, item) => {
  (grouped[item.group] ??= []).push(item);
  return grouped;
}, {});
const SECTION_GROUPS = Object.keys(SECTIONS_BY_GROUP);

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SECTIONS.some((candidate) => candidate.id === value);
}

export function SettingsSidebar({
  section,
  onSectionChange,
}: {
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="flex h-full w-full flex-col gap-0.5 overflow-y-auto p-2"
      style={{ background: "var(--bg-surface)" }}
    >
      <h2 data-settings-sidebar-title className="flex items-center gap-2 px-2.5 py-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
        <SettingsIcon size={18} aria-hidden="true" />
        Settings
      </h2>
      {SECTION_GROUPS.map((group) => (
        <div key={group} className="mb-1 flex flex-col gap-0.5">
          <span className="px-2.5 pt-2 pb-1 text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
            {group}
          </span>
          {SECTIONS_BY_GROUP[group]?.map((s) => {
            const active = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSectionChange(s.id)}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors duration-100 ${active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]"}`}
                style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
              >
                <span style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }}>{s.icon}</span>
                {s.label}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default function SettingsView({
  section: controlledSection,
  onSectionChange,
}: {
  section?: SettingsSectionId;
  onSectionChange?: (section: SettingsSectionId) => void;
} = {}) {
  const [localSection, setLocalSection] = useState<SettingsSectionId>("account");
  const requestedSection = useUi((s) => s.requestedSettingsSection);
  const section = controlledSection ?? localSection;
  const selectSection = onSectionChange ?? setLocalSection;

  // Deep links (for example the provider recovery CTA) request a section
  // before opening or focusing the Settings tab; consume it once.
  useEffect(() => {
    if (!requestedSection) return;
    if (controlledSection !== undefined) return;
    if (isSettingsSectionId(requestedSection)) setLocalSection(requestedSection);
    useUi.getState().clearRequestedSettingsSection();
  }, [controlledSection, requestedSection]);

  return (
    <div className="flex min-h-0 flex-1">
      {controlledSection === undefined ? (
        <SettingsSidebar section={section} onSectionChange={selectSection} />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full px-5 py-6">
          {section === "account" ? <AccountSection /> : null}
          {section === "billing" ? <BillingSection /> : null}
          {section === "appearance" ? <AppearanceSection /> : null}
          {section === "runtime" ? <RuntimeSection /> : null}
          {section === "agent" ? <AgentSection /> : null}
          {section === "providers" ? <ProvidersSection /> : null}
          {section === "integrations" ? <IntegrationsSettingsSection /> : null}
          {section === "cron" ? <CronSection /> : null}
          {section === "system" ? <SystemSection /> : null}
        </div>
      </div>
    </div>
  );
}
