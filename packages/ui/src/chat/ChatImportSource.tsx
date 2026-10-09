
import { SOURCE_OPTIONS, type ChatImportSourceFilterValue } from "./import-source.js";
import { settingsHarnessArtworkSrc } from "../coding-agent-artwork.js";

/** Exact Settings artwork identifies origin without implying the current execution harness. */
export function ChatImportSourceIcon({ harness, size = 14, imported = true }: { harness: "claude" | "codex"; size?: number; imported?: boolean }) {
  const label = `${imported ? "Imported from " : ""}${harness === "claude" ? "Claude Code" : "Codex"}`;
  return (
    <img src={settingsHarnessArtworkSrc(harness)} alt={label} title={label}
      className="matrix-chat-import-source-icon" data-harness={harness}
      width={size} height={size} draggable={false} loading="eager"
      style={{ flexShrink: 0, width: size, height: size, objectFit: "contain" }}/>
  );
}
export function ChatImportSourceFilter({ value, onChange }: {
  value: ChatImportSourceFilterValue; onChange: (value: ChatImportSourceFilterValue) => void;
}) {
  return <select aria-label="Chat source" value={value}
    className="min-w-0 w-full rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
    style={{ color: "var(--text-secondary, var(--muted-foreground))", borderColor: "var(--border-default, var(--border))" }}
    onChange={event => { const option = SOURCE_OPTIONS.find(entry => entry.value === event.currentTarget.value); if (option) onChange(option.value); }}>
    {SOURCE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}
