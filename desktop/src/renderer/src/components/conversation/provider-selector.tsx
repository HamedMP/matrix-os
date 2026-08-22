import type { ReactNode } from "react";
import type {
  ConversationProviderCapability,
  ConversationProviderIcon,
  ConversationProviderOption,
} from "./provider-options";

const CAPABILITY_LABEL: Record<ConversationProviderCapability, string> = {
  "current-conversation": "Current conversation",
  "project-conversation": "Project conversation",
  attachments: "Attachments",
  "project-context": "Project context",
  tools: "Tools",
};

export function ConversationProviderSelector({
  value,
  options,
  label = "Chat harness",
  onSelect,
  renderIcon,
}: {
  value: string;
  options: readonly ConversationProviderOption[];
  label?: string;
  onSelect: (providerId: string) => void;
  renderIcon?: (
    icon: ConversationProviderIcon,
    option: ConversationProviderOption,
  ) => ReactNode;
}) {
  const selected = options.find((option) => option.id === value);
  const title = selected
    ? selected.readiness.state === "disabled"
      ? `${selected.label} · ${selected.readiness.reason}`
      : `${selected.label} · ${selected.capabilities.map((capability) => CAPABILITY_LABEL[capability]).join(", ")}`
    : "Choose chat harness";

  return (
    <span className="relative inline-flex min-w-0 items-center">
      {selected && renderIcon ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-2 z-10 inline-flex size-3.5 items-center justify-center"
          style={{ color: "var(--text-secondary)" }}
        >
          {renderIcon(selected.icon, selected)}
        </span>
      ) : null}
      <select
        aria-label={label}
        value={value}
        className={`h-7 min-w-0 appearance-none rounded-full border bg-transparent pr-2 text-xs font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${selected && renderIcon ? "pl-7" : "px-2"}`}
        style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
        title={title}
        onChange={(event) => onSelect(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option
            key={option.id}
            value={option.id}
            disabled={option.readiness.state === "disabled"}
          >
            {option.readiness.state === "disabled"
              ? `${option.label} — ${option.readiness.reason}`
              : option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
