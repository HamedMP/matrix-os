
import { SOURCE_OPTIONS, type ChatImportSourceFilterValue } from "./import-source.js";

/** Compact monochrome marks identify origin without implying the current execution harness. */
export function ChatImportSourceIcon({ harness, size = 14, imported = true }: { harness: "claude" | "codex"; size?: number; imported?: boolean }) {
  const label = `${imported ? "Imported from " : ""}${harness === "claude" ? "Claude Code" : "Codex"}`;
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, color: "var(--text-tertiary, var(--muted-foreground))" }}>
      <title>{label}</title>
      {harness === "claude" ? <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4L18.4 5.6M8.6 3.7l6.8 16.6M3.7 8.6l16.6 6.8M3.7 15.4l16.6-6.8M8.6 20.3l6.8-16.6"/>
        : <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/></>}
    </svg>
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
