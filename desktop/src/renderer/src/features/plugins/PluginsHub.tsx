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

const SECTIONS: { id: PluginsSectionId; label: string; icon: React.ReactNode }[] = [
  { id: "integrations", label: "Integrations", icon: <Blocks size={15} /> },
  { id: "mcp", label: "MCP servers", icon: <Server size={15} /> },
  { id: "skills", label: "Skills", icon: <Sparkles size={15} /> },
  { id: "cli", label: "CLI", icon: <SquareTerminal size={15} /> },
];

export default function PluginsHub() {
  const [section, setSection] = useState<PluginsSectionId>("integrations");

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        className="flex w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <h2 className="px-2.5 py-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          Plugins
        </h2>
        {SECTIONS.map((s) => {
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
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-8">
          {section === "integrations" ? <IntegrationsSettingsSection /> : null}
          {section === "mcp" ? <McpServersSection /> : null}
          {section === "skills" ? <SkillsSection /> : null}
          {section === "cli" ? <CliSection /> : null}
        </div>
      </div>
    </div>
  );
}
