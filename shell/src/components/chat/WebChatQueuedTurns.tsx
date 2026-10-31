"use client";
import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { QueuedTurnsPanel, type QueuedTurnAction } from "@matrix-os/ui";
import { useState } from "react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const FAILURE: Record<Exclude<QueuedTurnAction, "move">, string> = {
  cancel: "Queued request could not be cancelled. Try again.",
  steer: "Queued message could not be steered. Try again.",
};

/** Web Chat's queued turns, attached above the composer like Electron Desktop. Editing and reordering stay Electron-only. */
export function WebChatQueuedTurns({ turns, canSteer = false, onCancel, onSteer }: {
  turns: CanonicalChatQueuedTurn[];
  canSteer?: boolean;
  onCancel?: (id: string) => Promise<boolean>;
  onSteer?: (id: string) => Promise<boolean>;
}) {
  const [pendingAction, setPendingAction] = useState<{ queuedTurnId: string; action: QueuedTurnAction } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (queuedTurnId: string, action: Exclude<QueuedTurnAction, "move">, operation?: (id: string) => Promise<boolean>) => {
    if (!operation || pendingAction) return;
    setPendingAction({ queuedTurnId, action }); setError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- Keep the queue action guard released in finally on both network and application failures.
    try { if (!await operation(queuedTurnId)) setError(FAILURE[action]); }
    catch (failure: unknown) {
      console.warn(`[chat] Queue ${action} failed:`, failure instanceof Error ? failure.name : "UnknownError");
      setError(FAILURE[action]);
    } finally { setPendingAction(null); }
  };
  if (!turns.length) return null;
  return <>
    <QueuedTurnsPanel
      turns={turns}
      disabled={!onCancel}
      canSteer={canSteer && Boolean(onSteer)}
      canEdit={false}
      pendingAction={pendingAction}
      menuZIndex={SHELL_Z_INDEX.popover}
      onSteer={(id) => void run(id, "steer", onSteer)}
      onCancel={(id) => void run(id, "cancel", onCancel)}
    />
    {error ? <p role="alert" className="relative z-[2] mt-3 px-1 text-xs text-destructive">{error}</p> : null}
  </>;
}
