import { ChevronDown } from "lucide-react";
import type { AgentThreadComposerDraft, RuntimeSummary } from "@matrix-os/contracts";

// The contracts package exposes AgentMode only as a schema; reuse the draft
// field's type so the picker stays aligned with the composer draft contract.
type ComposerMode = NonNullable<AgentThreadComposerDraft["mode"]>;

// Compact provider/mode pickers for the composer bottom row, Codex-style:
// minimal chrome, design-token colors, native selects for keyboard and
// screen-reader access. In draft mode both are editable; in a live thread the
// turn contract (CreateAgentTurnRequest carries only the message) cannot
// change provider or mode, so the provider picker renders display-only and
// the mode picker is omitted (the thread's mode is not part of the snapshot
// contract either, so there is nothing truthful to show).

function pickerClass(disabled: boolean): string {
  return [
    "h-6 max-w-[9.5rem] appearance-none truncate rounded-md border-0 bg-transparent pl-1.5 pr-5 text-xs font-medium outline-none transition-colors",
    disabled ? "cursor-default opacity-70" : "cursor-pointer hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
  ].join(" ");
}

function ComposerPicker({
  ariaLabel,
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <span className="relative inline-flex min-w-0 items-center">
      <select
        aria-label={ariaLabel}
        className={pickerClass(disabled)}
        style={{ color: "var(--text-secondary)" }}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={12}
        aria-hidden="true"
        className="pointer-events-none absolute right-1.5"
        style={{ color: "var(--text-tertiary)" }}
      />
    </span>
  );
}

export function AgentComposerPickers({
  summary,
  providerId,
  mode,
  readOnly = false,
  onProviderChange,
  onModeChange,
}: {
  summary: RuntimeSummary;
  providerId: string | undefined;
  mode: ComposerMode | undefined;
  // Thread mode: provider picker renders display-only, mode picker hidden.
  readOnly?: boolean;
  onProviderChange?: (providerId: string) => void;
  onModeChange?: (mode: ComposerMode) => void;
}) {
  const providers = summary.providers;
  const selected = providers.find((provider) => provider.id === providerId) ?? providers[0];
  if (!selected) return null;
  const providerOptions = providers.map((provider) => ({ value: provider.id, label: provider.displayName }));
  const modeOptions = selected.supportedModes.map((candidate) => ({
    value: candidate,
    label: candidate.replace(/_/g, " "),
  }));
  return (
    <>
      <ComposerPicker
        ariaLabel="Agent provider"
        value={selected.id}
        options={providerOptions}
        disabled={readOnly}
        onChange={readOnly ? undefined : onProviderChange}
      />
      {readOnly ? null : (
        <ComposerPicker
          ariaLabel="Agent mode"
          value={mode ?? selected.defaultMode}
          options={modeOptions}
          disabled={false}
          onChange={(value) => onModeChange?.(value as ComposerMode)}
        />
      )}
    </>
  );
}
