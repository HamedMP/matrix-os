import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  MoreHorizontal,
  PencilIcon,
  Trash2,
} from "@renderer/lib/hugeicons";
import type { ReactNode } from "react";

import { DESKTOP_Z_INDEX } from "../../design/layering";

function queuedTurnLabel(turn: CanonicalChatQueuedTurn): string {
  for (const part of turn.parts) {
    if (part.type === "text" && part.text.trim()) return part.text.trim();
    if (part.type === "attachment_reference") return part.label;
    if (part.type === "resource_reference") return part.resource.label;
    if (part.type === "invocation_reference") return part.invocation.invocation;
  }
  return "Queued message";
}

export type QueuedTurnAction = "move" | "cancel";

function QueueMenuItem({
  icon,
  label,
  accessibleLabel,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  accessibleLabel: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      aria-label={accessibleLabel}
      disabled={disabled}
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none data-[disabled]:opacity-35 data-[highlighted]:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-primary)" }}
    >
      <span className="flex size-4 items-center justify-center" style={{ color: "var(--text-secondary)" }}>
        {icon}
      </span>
      {label}
    </DropdownMenu.Item>
  );
}

export function QueuedTurnsPanel({
  turns,
  disabled = false,
  canSteer = false,
  pendingAction = null,
  editingQueuedTurnId = null,
  onSteer,
  onEdit,
  onMove,
  onCancel,
}: {
  turns: CanonicalChatQueuedTurn[];
  disabled?: boolean;
  canSteer?: boolean;
  pendingAction?: { queuedTurnId: string; action: QueuedTurnAction } | null;
  editingQueuedTurnId?: string | null;
  onSteer: (queuedTurnId: string) => void;
  onEdit: (queuedTurnId: string) => void;
  onMove: (queuedTurnId: string, direction: -1 | 1) => void;
  onCancel: (queuedTurnId: string) => void;
}) {
  if (turns.length === 0) return null;
  const ordered = [...turns].sort((left, right) => left.position - right.position);
  return (
    <section
      role="region"
      aria-label="Queued turns"
      data-attached-to-composer="true"
      data-queue-card-style="codex"
      data-queue-density="compact"
      className="relative z-0 mx-3 -mb-2 overflow-hidden rounded-[18px] border pb-2"
      style={{
        borderColor: "var(--border-default)",
        background: "color-mix(in srgb, var(--bg-surface) 82%, var(--bg-sunken))",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <ol className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
        {ordered.map((turn, index) => {
          const label = queuedTurnLabel(turn);
          const rowPending = pendingAction?.queuedTurnId === turn.id;
          const editing = editingQueuedTurnId === turn.id;
          const rowDisabled = disabled || rowPending || editing;
          return (
            <li key={turn.id} className="flex min-h-10 min-w-0 items-center gap-2 px-4 py-1.5">
              <CornerDownLeft
                size={16}
                aria-hidden
                className="shrink-0 -rotate-90"
                style={{ color: "var(--text-tertiary)" }}
              />
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5" style={{ color: "var(--text-primary)" }}>
                {label}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={`Steer ${label}`}
                  disabled={rowDisabled || !canSteer}
                  className="h-7 rounded-lg px-2 text-[13px] font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => onSteer(turn.id)}
                >
                  Steer
                </button>
                <button
                  type="button"
                  aria-label={`Cancel ${label}`}
                  disabled={rowDisabled}
                  className="flex size-7 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-35"
                  style={{ color: "var(--text-tertiary)" }}
                  onClick={() => onCancel(turn.id)}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      aria-label={`More actions for ${label}`}
                      disabled={rowDisabled}
                      className="flex size-7 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-35"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      <MoreHorizontal size={16} aria-hidden />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      aria-label={`Actions for ${label}`}
                      align="end"
                      side="top"
                      sideOffset={6}
                      collisionPadding={12}
                      className="fade-in min-w-[156px] rounded-xl border p-1.5"
                      style={{
                        zIndex: DESKTOP_Z_INDEX.popover,
                        background: "var(--bg-overlay)",
                        borderColor: "var(--border-default)",
                        boxShadow: "var(--shadow-2)",
                      }}
                    >
                      <QueueMenuItem
                        icon={<PencilIcon size={14} aria-hidden />}
                        label="Edit"
                        accessibleLabel={`Edit ${label}`}
                        onSelect={() => onEdit(turn.id)}
                      />
                      <QueueMenuItem
                        icon={<ChevronUp size={15} aria-hidden />}
                        label="Move up"
                        accessibleLabel={`Move ${label} up`}
                        disabled={index === 0}
                        onSelect={() => onMove(turn.id, -1)}
                      />
                      <QueueMenuItem
                        icon={<ChevronDown size={15} aria-hidden />}
                        label="Move down"
                        accessibleLabel={`Move ${label} down`}
                        disabled={index === ordered.length - 1}
                        onSelect={() => onMove(turn.id, 1)}
                      />
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
