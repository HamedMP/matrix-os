// Plugins hub: the desktop's Kimi-style extension surface. One page gathers
// the integration center (the promoted IntegrationsSettingsSection, shared
// with Settings), MCP servers (honest empty state — no listing route exists),
// skills (real list from GET /api/settings/skills), and the Matrix CLI
// install card. Section nav mirrors SettingsView's layout.
import { Blocks, Server, Sparkles, SquareTerminal } from "lucide-react";
import { useState } from "react";
import IntegrationsSettingsSection from "../integrations/IntegrationsSettingsSection";
import CliSection from "./CliSection";
import McpServersSection from "./McpServersSection";
import SkillsSection from "./SkillsSection";

type PluginsSectionId = "integrations" | "mcp" | "skills" | "cli";

const SECTIONS: { id: PluginsSectionId; label: string; description: string; icon: React.ReactNode }[] = [
  { id: "integrations", label: "Integrations", description: "Connect services", icon: <Blocks size={15} /> },
  { id: "mcp", label: "MCP servers", description: "Extend agent tools", icon: <Server size={15} /> },
  { id: "skills", label: "Skills", description: "Reusable instructions", icon: <Sparkles size={15} /> },
  { id: "cli", label: "CLI", description: "Connect your terminal", icon: <SquareTerminal size={15} /> },
];

export default function PluginsHub() {
  const [section, setSection] = useState<PluginsSectionId>("integrations");

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Plugin categories"
        className="flex w-[224px] shrink-0 flex-col gap-1 overflow-y-auto border-r p-2.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <div className="mb-1 flex items-center gap-2.5 px-2 py-2">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
          >
            <Blocks size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-tight" style={{ color: "var(--text-primary)" }}>
              Plugins
            </h2>
            <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Extend this computer</p>
          </div>
        </div>
        {SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setSection(s.id)}
              className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all duration-150 ${active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]"}`}
              style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                style={{
                  color: active ? "var(--accent)" : "var(--text-tertiary)",
                  background: active ? "var(--accent-muted)" : "transparent",
                }}
              >
                {s.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-tight">{s.label}</span>
                <span className="mt-0.5 block truncate text-[11px] font-normal" style={{ color: "var(--text-tertiary)" }}>
                  {s.description}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[780px] px-10 py-10">
          {section === "integrations" ? <IntegrationsSettingsSection /> : null}
          {section === "mcp" ? <McpServersSection /> : null}
          {section === "skills" ? <SkillsSection /> : null}
          {section === "cli" ? <CliSection /> : null}
        </div>
      </div>
    </div>
  );
}
