import { Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button, IconButton, Icon } from "../../../design/ds";

export interface SelectionAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * Floating bar centred at the bottom while two or more entries are selected:
 * "N selected", xs ghost actions, a ghost-destructive Trash and Clear.
 * Only actions that work are passed in; nothing is shown disabled for missing features.
 */
export function SelectionBar({
  count,
  actions,
  onTrash,
  onClear,
}: {
  count: number;
  actions: SelectionAction[];
  onTrash?: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div role="toolbar" aria-label={`${count} selected`} className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-ds-border bg-ds-popover p-1 font-ds-sans shadow-ds-lg">
      <span className="px-2 text-ds-ui-sm font-medium text-ds-foreground tabular-nums" aria-live="polite">{count} selected</span>
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-ds-tint-neutral-border" />
      {actions.map((action) => (
        <Button key={action.id} variant="ghost" size="xs" disabled={action.disabled} onClick={action.onSelect}>
          {action.icon}
          {action.label}
        </Button>
      ))}
      {onTrash ? (
        <IconButton label="Move to Trash" shortcut="⌘⌫" variant="ghost-destructive" size="xs" onClick={onTrash}>
          <Icon icon={Trash2} size="xs" />
        </IconButton>
      ) : null}
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-ds-tint-neutral-border" />
      <Button variant="ghost" size="xs" onClick={onClear}>
        <Icon icon={X} size="xs" />
        Clear
      </Button>
    </div>
  );
}
