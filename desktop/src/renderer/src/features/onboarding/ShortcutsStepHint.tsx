import type { CSSProperties } from "react";
import { onboardingChecklist } from "@matrix-os/brand";
import { SHORTCUT_ACTIONS } from "@matrix-os/contracts/keyboard-shortcuts";
import { KeyChip, spokenBinding } from "@matrix-os/ui/shortcuts";
import "@matrix-os/ui/shortcuts.css";
import { useShortcuts } from "../../stores/shortcuts";
import { SHORTCUTS_STEP_ACTIONS } from "./shortcuts-step";

const COLORS = onboardingChecklist.colors;
// The shared key chips take their colors from these tokens; use the checklist palette.
const CHIP_TOKENS = {
  "--mxs-sunken": COLORS.surface,
  "--mxs-border-strong": COLORS.border,
  "--mxs-text": COLORS.text,
} as CSSProperties;
const HINT_TEXT: CSSProperties = { color: COLORS.subtleText, fontSize: 10 };

/** The keyboard shortcuts step's help: a few shortcuts by their current keys, and where to change them. */
export function ShortcutsStepHint() {
  const snapshot = useShortcuts((state) => state.snapshot);
  const shown = snapshot
    ? SHORTCUTS_STEP_ACTIONS.flatMap((id) => {
      const binding = snapshot.effective[id]?.[0];
      const label = SHORTCUT_ACTIONS.find((action) => action.id === id)?.label;
      return binding && label ? [{ id, binding, label }] : [];
    })
    : [];
  return (
    <span className="mt-1 flex flex-col gap-1" style={CHIP_TOKENS}>
      {snapshot && shown.map(({ id, binding, label }) => (
        <span key={id} className="flex min-w-0 items-center gap-1.5">
          <KeyChip compact binding={binding} platform={snapshot.platform} label={spokenBinding(binding, snapshot.platform)} />
          <span className="truncate" style={HINT_TEXT}>{label}</span>
        </span>
      ))}
      <span className="block truncate" style={HINT_TEXT}>Change them in Settings</span>
    </span>
  );
}
