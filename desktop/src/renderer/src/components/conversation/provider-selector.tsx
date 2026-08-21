import type { ConversationProviderOption } from "./presentation";

export function ConversationProviderSelector({
  value,
  options,
  label = "Chat harness",
  onSelect,
}: {
  value: string;
  options: ConversationProviderOption[];
  label?: string;
  onSelect: (providerId: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      className="h-7 appearance-none rounded-full border bg-transparent px-2 text-xs font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
      title="Choose chat harness"
      onChange={(event) => onSelect(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id} disabled={!option.available}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
