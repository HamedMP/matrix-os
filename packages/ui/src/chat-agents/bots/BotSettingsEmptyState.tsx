import { botSettingsEmptyStates, type BotSettingsSection } from "@matrix-os/contracts";
import { chatAgentMutedStyle } from "../theme.js";

export function BotSettingsEmptyState({ section }: { section: BotSettingsSection }) {
  const copy = botSettingsEmptyStates[section];
  return <div className="matrix-bot-settings-card grid gap-3 py-6">
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={chatAgentMutedStyle}>
      {section === "connections" ? <><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></> : null}
      {section === "memory" ? <><path d="M12 4a4 4 0 0 0-7 3 4 4 0 0 0-2 7 4 4 0 0 0 4 6h1a4 4 0 0 0 4-4V4Zm0 0a4 4 0 0 1 7 3 4 4 0 0 1 2 7 4 4 0 0 1-4 6h-1a4 4 0 0 1-4-4M6 10h2M16 10h2M7 16h2M15 16h2" /></> : null}
      {section === "routines" ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> : null}
    </svg>
    <h4 className="text-sm font-semibold">{copy.title}</h4>
    <p className="text-xs leading-relaxed" style={chatAgentMutedStyle}>{copy.description}</p>
    <p className="text-xs leading-relaxed">{copy.hint}</p>
  </div>;
}
