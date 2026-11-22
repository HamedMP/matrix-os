import type { CSSProperties } from "react";
import { X } from "lucide-react";
import { formatBinding, type ShortcutPlatform } from "@matrix-os/contracts/keyboard-shortcuts";
import { Button } from "../Button.js";
import { quietButtonStyle } from "./quiet-button-style.js";
import { removeLabel } from "./shortcut-copy.js";

const removeStyle: CSSProperties = {
  ...quietButtonStyle,
  width: "24px",
  height: "24px",
  padding: 0,
};

export interface KeyChipProps {
  binding: string;
  platform: ShortcutPlatform;
  /** Accessible name for the keys, e.g. "Control Tab". */
  label: string;
  onRemove?: () => void;
  removeDisabled?: boolean;
}

/** Keys for one binding in a single chip, with an optional remove control. */
export function KeyChip({ binding, platform, label, onRemove, removeDisabled }: KeyChipProps) {
  const parts = formatBinding(binding, platform);
  return (
    <span className="mxs-chip-line">
      <span className="mxs-chip" role="group" aria-label={label}>
        {parts.map((part, index) => (
          // A binding never repeats a part, but the index keeps keys unique regardless.
          <kbd key={`${index}-${part}`} className="mxs-key">
            {part}
          </kbd>
        ))}
      </span>
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className="mxs-quiet mxs-chip-remove"
          style={removeStyle}
          aria-label={removeLabel(binding, platform)}
          disabled={removeDisabled}
          onClick={onRemove}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
      ) : (
        <span className="mxs-chip-remove-space" aria-hidden="true" />
      )}
    </span>
  );
}
