import { Bug, CircleCheck, Hammer, Search } from "lucide-react";

const STARTERS = [
  { label: "Explore and understand code", Icon: Search, tone: "var(--success)" },
  { label: "Build a new feature, app, or tool", Icon: Hammer, tone: "var(--info)" },
  { label: "Review code and suggest changes", Icon: CircleCheck, tone: "var(--success)" },
  { label: "Fix issues and failures", Icon: Bug, tone: "var(--warning)" },
] as const;

export function ChatStarterCards({ onSelect }: { onSelect: (prompt: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-slot="chat-starter-cards">
      {STARTERS.map(({ label, Icon, tone }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          onClick={() => onSelect(label)}
          className="flex min-h-32 flex-col items-start justify-between rounded-xl border p-4 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <span className="flex size-8 items-center justify-center rounded-lg" style={{ background: "var(--bg-sunken)", color: tone }}>
            <Icon size={17} aria-hidden />
          </span>
          <span className="max-w-32 text-sm font-medium leading-snug" style={{ color: "var(--text-primary)" }}>
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}
