import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { ChevronDown, ChevronUp, XIcon } from "@renderer/lib/hugeicons";

function queuedTurnLabel(turn: CanonicalChatQueuedTurn): string {
  for (const part of turn.parts) {
    if (part.type === "text" && part.text.trim()) return part.text.trim();
    if (part.type === "attachment_reference") return part.label;
    if (part.type === "resource_reference") return part.resource.label;
    if (part.type === "invocation_reference") return part.invocation.invocation;
  }
  return "Queued message";
}

export function QueuedTurnsPanel({
  turns,
  disabled = false,
  onMove,
  onCancel,
}: {
  turns: CanonicalChatQueuedTurn[];
  disabled?: boolean;
  onMove: (queuedTurnId: string, direction: -1 | 1) => void;
  onCancel: (queuedTurnId: string) => void;
}) {
  if (turns.length === 0) return null;
  const ordered = [...turns].sort((left, right) => left.position - right.position);
  return (
    <section
      role="region"
      aria-label="Queued turns"
      className="mb-2 overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="text-[12px] font-semibold" style={{ color: "var(--text-secondary)" }}>Up next</span>
        <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          {ordered.length} {ordered.length === 1 ? "turn" : "turns"}
        </span>
      </div>
      <ol className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
        {ordered.map((turn, index) => {
          const label = queuedTurnLabel(turn);
          return (
            <li key={turn.id} className="flex min-w-0 items-center gap-2 px-3 py-2">
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{ background: "var(--bg-active)", color: "var(--text-tertiary)" }}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--text-primary)" }}>
                {label}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-label={`Move ${label} up`}
                  disabled={disabled || index === 0}
                  className="flex size-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] disabled:opacity-30"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => onMove(turn.id, -1)}
                >
                  <ChevronUp size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${label} down`}
                  disabled={disabled || index === ordered.length - 1}
                  className="flex size-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] disabled:opacity-30"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => onMove(turn.id, 1)}
                >
                  <ChevronDown size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Cancel ${label}`}
                  disabled={disabled}
                  className="flex size-7 items-center justify-center rounded-md hover:bg-[var(--danger-muted)] disabled:opacity-30"
                  style={{ color: "var(--text-tertiary)" }}
                  onClick={() => onCancel(turn.id)}
                >
                  <XIcon size={13} aria-hidden />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
