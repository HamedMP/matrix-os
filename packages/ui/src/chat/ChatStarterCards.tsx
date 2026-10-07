import "./chat-presentation.css";
import { ChatIcon } from "./ChatIcon.js";

const STARTERS = [
  { label: "Explore and understand code", icon: "search" },
  { label: "Build a new feature, app, or tool", icon: "hammer" },
  { label: "Review code and suggest changes", icon: "check" },
  { label: "Fix issues and failures", icon: "bug" },
] as const;

export function ChatStarterCards({
  layout = "responsive",
  density = "regular",
  onSelect,
}: {
  layout?: "responsive" | "two-by-two";
  density?: "regular" | "compact";
  onSelect: (prompt: string) => void;
}) {
  return (
    <div className="matrix-chat-starters" data-slot="chat-starter-cards" data-layout={layout} data-density={density}>
      {STARTERS.map(({ label, icon }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          onClick={() => onSelect(label)}
          className="matrix-chat-starters__card"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <span className="matrix-chat-starters__icon" style={{ background: "var(--bg-sunken)", color: "var(--chat-muted, var(--text-secondary))" }}>
            <ChatIcon name={icon} size={17} />
          </span>
          <span className="matrix-chat-starters__label" style={{ color: "var(--text-primary)" }}>
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}
