import { CircleAlert } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";

export interface ChatNoticeCardAction { key: string; label: string }

/**
 * Transcript notice shared by Web and Electron Desktop Chat: title, body and
 * fixed-label actions. A failed action leaves the notice in place.
 */
export function ChatNoticeCard({ label, failed, children, actions = [], onAction }: {
  label: string;
  failed: boolean;
  children: ReactNode;
  actions?: readonly ChatNoticeCardAction[];
  onAction?: (key: string) => Promise<void> | void;
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const visibleActions = onAction ? actions : [];
  const perform = async (key: string) => {
    if (!onAction || pendingAction) return;
    setPendingAction(key);
    setActionFailed(false);
    try {
      await onAction(key);
    } catch (error: unknown) {
      console.warn("[chat] notice action failed:", error instanceof Error ? error.name : "UnknownError");
      setActionFailed(true);
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <div
      role="status"
      aria-label={label}
      className={`w-fit min-w-[20rem] max-w-full rounded-xl border px-3 py-2.5 text-sm sm:max-w-[42rem] ${failed ? "flex items-start gap-2.5" : ""}`}
      style={{ borderColor: failed ? "var(--danger)" : "var(--border-default)", color: "var(--text-primary)" }}
    >
      {failed ? (
        <HugeiconsIcon icon={CircleAlert} size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0"
          style={{ color: "var(--danger-text, var(--danger))" }} />
      ) : null}
      <div className="min-w-0">
        <p className="font-medium leading-5">{label}</p>
        <div className="mt-0.5 leading-5" style={{ color: "var(--text-secondary)" }}>{children}</div>
        {visibleActions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {visibleActions.map((action) => (
              <button
                key={action.key}
                type="button"
                aria-label={`${action.label} ${label}`}
                disabled={pendingAction !== null}
                className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--ring,var(--accent))] disabled:opacity-50"
                style={{ borderColor: "var(--border-default)" }}
                onClick={() => void perform(action.key)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        {actionFailed ? <p role="alert" className="mt-1 text-xs">The action failed. Try again.</p> : null}
      </div>
    </div>
  );
}
