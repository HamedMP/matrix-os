import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { GripVerticalIcon, MoreHorizontal, PencilIcon, Trash2 } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";

import { hasChatMentionParts } from "../../chat-agents/mentions.js";
import { SubmittedBotAnswers, isBotAnswerContinuation } from "../../chat-agents/bots/SubmittedBotAnswers.js";

function queuedTurnLabel(turn: CanonicalChatQueuedTurn): string {
  for (const part of turn.parts) {
    if (part.type === "text" && part.text.trim()) return part.text.trim();
    if (part.type === "attachment_reference") return part.label;
    if (part.type === "resource_reference") return part.resource.label;
    if (part.type === "invocation_reference") return part.invocation.invocation;
  }
  return "Queued message";
}

export type QueuedTurnAction = "move" | "cancel" | "steer";

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

/**
 * Queued turns attached above the Chat composer, shared by Web and Electron
 * Desktop. Edit and drag reorder render only for hosts that pass their handler.
 */
export function QueuedTurnsPanel({
  turns,
  disabled = false,
  canSteer = false,
  canEdit = true,
  pendingAction = null,
  editingQueuedTurnId = null,
  menuZIndex,
  onSteer,
  onEdit,
  onReorder,
  onCancel,
}: {
  turns: CanonicalChatQueuedTurn[];
  disabled?: boolean;
  canSteer?: boolean;
  canEdit?: boolean;
  pendingAction?: { queuedTurnId: string; action: QueuedTurnAction } | null;
  editingQueuedTurnId?: string | null;
  menuZIndex?: number;
  onSteer: (queuedTurnId: string) => void;
  onEdit?: (queuedTurnId: string) => void;
  onReorder?: (queuedTurnIds: string[], movedQueuedTurnId: string) => void;
  onCancel: (queuedTurnId: string) => void;
}) {
  // Only drag handlers read the dragged row, so it needs no re-render.
  const draggedTurnId = useRef<string | null>(null);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  if (turns.length === 0) return null;
  const answers = turns.filter(isBotAnswerContinuation);
  const ordered = turns.filter(turn => !isBotAnswerContinuation(turn)).sort((left, right) => left.position - right.position);
  if (!ordered.length) return <SubmittedBotAnswers turns={answers} onCancel={onCancel} disabled={disabled || pendingAction !== null} />;

  const reorder = (queuedTurnId: string, targetTurnId: string) => {
    const currentIndex = ordered.findIndex((turn) => turn.id === queuedTurnId);
    const targetIndex = ordered.findIndex((turn) => turn.id === targetTurnId);
    if (currentIndex < 0 || targetIndex < 0 || currentIndex === targetIndex) return;
    const next = [...ordered];
    const [moved] = next.splice(currentIndex, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    let index = 0;
    const all = [...turns].sort((left, right) => left.position - right.position);
    onReorder?.(all.map(turn => isBotAnswerContinuation(turn) ? turn.id : next[index++]!.id), queuedTurnId);
  };

  const keyboardReorder = (
    event: KeyboardEvent<HTMLButtonElement>,
    queuedTurnId: string,
    index: number,
  ) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const target = ordered[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (!target) return;
    event.preventDefault();
    reorder(queuedTurnId, target.id);
  };

  return (
    <>
    <SubmittedBotAnswers turns={answers} onCancel={onCancel} disabled={disabled || pendingAction !== null} />
    <section
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
          const editing = editingQueuedTurnId === turn.id;
          const steering = pendingAction?.queuedTurnId === turn.id && pendingAction.action === "steer";
          const rowDisabled = disabled || pendingAction !== null || editing;
          return (
            <li
              key={turn.id}
              data-drag-target={dragTargetId === turn.id ? "true" : undefined}
              className="flex min-h-10 min-w-0 items-center gap-2 px-3 py-1.5 transition-colors data-[drag-target=true]:bg-[var(--bg-hover)]"
              onDragOver={(event: DragEvent<HTMLLIElement>) => {
                if (!onReorder || !draggedTurnId.current || draggedTurnId.current === turn.id || rowDisabled) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragTargetId(turn.id);
              }}
              onDrop={(event: DragEvent<HTMLLIElement>) => {
                event.preventDefault();
                if (draggedTurnId.current && !rowDisabled) reorder(draggedTurnId.current, turn.id);
                draggedTurnId.current = null;
                setDragTargetId(null);
              }}
            >
              {onReorder ? <button
                type="button"
                draggable={!rowDisabled}
                aria-label={`Reorder ${label}`}
                disabled={rowDisabled}
                className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:cursor-grabbing disabled:cursor-default disabled:opacity-35"
                style={{ color: "var(--text-tertiary)" }}
                onKeyDown={(event) => keyboardReorder(event, turn.id, index)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", turn.id);
                  draggedTurnId.current = turn.id;
                }}
                onDragEnd={() => {
                  draggedTurnId.current = null;
                  setDragTargetId(null);
                }}
              >
                <HugeiconsIcon icon={GripVerticalIcon} size={16} strokeWidth={1.5} aria-hidden />
              </button> : null}
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5" style={{ color: "var(--text-primary)" }}>
                {label}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={`${steering ? "Steering" : "Steer"} ${label}`}
                  disabled={rowDisabled || !canSteer || hasChatMentionParts(turn.parts)}
                  className="h-7 rounded-lg px-2 text-[13px] font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => onSteer(turn.id)}
                >
                  {steering ? "Steering…" : "Steer"}
                </button>
                <button
                  type="button"
                  aria-label={`Cancel ${label}`}
                  disabled={rowDisabled}
                  className="flex size-7 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-35"
                  style={{ color: "var(--text-tertiary)" }}
                  onClick={() => onCancel(turn.id)}
                >
                  <HugeiconsIcon icon={Trash2} size={15} strokeWidth={1.5} aria-hidden />
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
                      <HugeiconsIcon icon={MoreHorizontal} size={16} strokeWidth={1.5} aria-hidden />
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
                        ...(menuZIndex === undefined ? {} : { zIndex: menuZIndex }),
                        background: "var(--bg-overlay)",
                        borderColor: "var(--border-default)",
                        boxShadow: "var(--shadow-2)",
                      }}
                    >
                      <QueueMenuItem
                        icon={<HugeiconsIcon icon={PencilIcon} size={14} strokeWidth={1.5} aria-hidden />}
                        label="Edit"
                        disabled={!canEdit || !onEdit}
                        accessibleLabel={`Edit ${label}`}
                        onSelect={() => onEdit?.(turn.id)}
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
    </>
  );
}
