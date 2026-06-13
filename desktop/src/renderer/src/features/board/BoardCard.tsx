import { SquareTerminal } from "lucide-react";
import { useState } from "react";
import { ContextMenu, type MenuItem } from "../../design/primitives";
import { useBoard, BOARD_COLUMNS, type Card } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

const PRIORITY_STYLE: Record<Card["priority"], { label: string; color: string } | null> = {
  low: { label: "Low", color: "var(--text-tertiary)" },
  normal: null,
  high: { label: "High", color: "var(--warning)" },
  urgent: { label: "Urgent", color: "var(--danger)" },
};

export default function BoardCard({ card, overlay = false }: { card: Card; overlay?: boolean }) {
  const navigate = useUi((s) => s.navigate);
  const api = useConnection((s) => s.api);
  const updateTask = useBoard((s) => s.updateTask);
  const archiveTask = useBoard((s) => s.archiveTask);
  const deleteTask = useBoard((s) => s.deleteTask);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const priority = PRIORITY_STYLE[card.priority];

  const menuItems: MenuItem[] = [
    { label: "Open", onSelect: () => navigate({ kind: "task", taskId: card.id }) },
    ...BOARD_COLUMNS.filter((s) => s !== card.status).map((status) => ({
      label: `Move to ${status[0]?.toUpperCase()}${status.slice(1)}`,
      onSelect: () => {
        if (api) void updateTask(api, card.projectSlug, card.id, { status });
      },
    })),
    {
      label: "Archive",
      onSelect: () => {
        if (api) void archiveTask(api, card.projectSlug, card.id);
      },
    },
    {
      label: "Delete",
      danger: true,
      onSelect: () => {
        if (api) void deleteTask(api, card.projectSlug, card.id);
      },
    },
  ];

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-default flex-col gap-1.5 rounded-lg border p-2.5 transition-colors duration-100"
        style={{
          background: "var(--bg-raised)",
          borderColor: "var(--border-subtle)",
          boxShadow: overlay ? "var(--shadow-2)" : "var(--shadow-1)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-subtle)")}
        onClick={() => navigate({ kind: "task", taskId: card.id })}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate({ kind: "task", taskId: card.id });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="text-sm leading-snug" style={{ color: "var(--text-primary)" }}>
          {card.title}
        </span>
        {priority || card.tags.length > 0 || card.linkedSessionId ? (
          <div className="flex items-center gap-1.5">
            {priority ? (
              <span className="text-xs font-medium" style={{ color: priority.color }}>
                {priority.label}
              </span>
            ) : null}
            {card.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded px-1.5 py-px text-xs"
                style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}
              >
                {tag}
              </span>
            ))}
            <div className="flex-1" />
            {card.linkedSessionId ? (
              <SquareTerminal size={13} style={{ color: "var(--text-tertiary)" }} />
            ) : null}
          </div>
        ) : null}
      </div>
      {!overlay ? <ContextMenu position={menuPos} items={menuItems} onClose={() => setMenuPos(null)} /> : null}
    </>
  );
}
