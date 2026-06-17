import { GitBranch, Globe, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { ContextMenu, StatusDot, type MenuItem } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { startTaskSession } from "../../lib/task-sessions";
import { useBoard, BOARD_COLUMNS, type Card } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useGit } from "../../stores/git";
import { useSessions } from "../../stores/sessions";
import { useTabs } from "../../stores/tabs";

const PRIORITY_STYLE: Record<Card["priority"], { label: string; color: string } | null> = {
  low: { label: "Low", color: "var(--text-tertiary)" },
  normal: null,
  high: { label: "High", color: "var(--warning)" },
  urgent: { label: "Urgent", color: "var(--danger)" },
};

export default function BoardCard({ card, overlay = false }: { card: Card; overlay?: boolean }) {
  const openTab = useTabs((s) => s.openTab);
  const openCard = () =>
    openTab({ kind: "task", taskId: card.id, projectSlug: card.projectSlug, title: card.title });
  const api = useConnection((s) => s.api);
  const updateTask = useBoard((s) => s.updateTask);
  const archiveTask = useBoard((s) => s.archiveTask);
  const deleteTask = useBoard((s) => s.deleteTask);
  // Raw store slices (stable refs); derive per-card view with useMemo so the
  // selector never allocates a fresh array each render (Zustand rule).
  const sessions = useSessions((s) => s.sessions);
  const aliasMap = useSessions((s) => s.aliasMap);
  const worktrees = useGit((s) => s.worktrees);
  const previews = useGit((s) => s.previews);
  const [startError, setStartError] = useState<string | null>(null);

  const sessionLive = useMemo(() => {
    if (!card.linkedSessionId) return false;
    const attach = aliasMap[card.linkedSessionId];
    return attach ? sessions.some((s) => s.attachName === attach && s.status === "active") : false;
  }, [card.linkedSessionId, aliasMap, sessions]);

  const worktree = useMemo(
    () => (card.linkedWorktreeId ? worktrees.find((w) => w.id === card.linkedWorktreeId) ?? null : null),
    [card.linkedWorktreeId, worktrees],
  );

  const cardPreviews = useMemo(() => previews.filter((p) => p.taskId === card.id), [previews, card.id]);
  const previewUrl = useMemo(() => {
    for (const preview of cardPreviews) {
      if (typeof preview.url !== "string" || preview.url.length === 0) continue;
      try {
        const url = new URL(preview.url);
        if (url.protocol === "https:") return url.toString();
      } catch (err: unknown) {
        console.warn("[board] Ignoring invalid preview URL:", err instanceof Error ? err.message : String(err));
      }
    }
    return null;
  }, [cardPreviews]);
  const previewColor =
    cardPreviews.length === 0
      ? null
      : cardPreviews.some((p) => p.lastStatus === "failed")
        ? "var(--danger)"
        : cardPreviews.every((p) => p.lastStatus === "ok")
          ? "var(--success)"
          : "var(--text-tertiary)";

  const priority = PRIORITY_STYLE[card.priority];
  const hasBadges =
    priority !== null ||
    card.tags.length > 0 ||
    card.linkedSessionId !== null ||
    worktree !== null ||
    cardPreviews.length > 0;

  const startAgent = async (agent: "claude" | "codex") => {
    if (!api || sessionLive) return;
    setStartError(null);
    try {
      const ok = await startTaskSession(api, {
        projectSlug: card.projectSlug,
        taskId: card.id,
        worktreeId: card.linkedWorktreeId,
        title: card.title,
        description: card.description,
        kind: "agent",
        agent,
      });
      if (!ok) {
        setStartError(`Couldn't start ${agent}.`);
        console.warn(`[board] Failed to start ${agent} session for task ${card.id}`);
      }
    } catch (err: unknown) {
      setStartError(`Couldn't start ${agent}.`);
      console.warn("[board] Start agent failed:", err instanceof Error ? err.message : String(err));
    }
  };

  const menuItems: MenuItem[] = [
    { label: "Open", onSelect: openCard },
    ...(sessionLive
      ? []
      : [
          { label: "Start Claude", onSelect: () => void startAgent("claude") },
          { label: "Start Codex", onSelect: () => void startAgent("codex") },
        ]),
    ...(previewUrl
      ? [{ label: "Open preview", onSelect: () => void invoke("shell:open-external", { url: previewUrl }) }]
      : []),
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

  const cardBody = (
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
      onClick={openCard}
      onKeyDown={(e) => {
        if (e.key === "Enter") openCard();
      }}
    >
      <span className="text-sm leading-snug" style={{ color: "var(--text-primary)" }}>
        {card.title}
      </span>
      {hasBadges ? (
        <div className="flex items-center gap-1.5">
          {priority ? (
            <span className="text-xs font-medium" style={{ color: priority.color }}>
              {priority.label}
            </span>
          ) : null}
          {card.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="rounded px-1.5 py-px text-xs"
              style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}
            >
              {tag}
            </span>
          ))}
          <div className="flex-1" />
          {worktree ? (
            <span
              className="flex items-center gap-0.5 text-xs"
              style={{ color: "var(--text-tertiary)" }}
              title={worktree.dirtyState === "dirty" ? "Uncommitted changes" : "Clean"}
            >
              <GitBranch size={11} />
              {worktree.dirtyCount ? <span style={{ color: "var(--highlight)" }}>±{worktree.dirtyCount}</span> : null}
            </span>
          ) : null}
          {previewColor ? <Globe size={12} style={{ color: previewColor }} /> : null}
          {card.linkedSessionId ? (
            <span className="flex items-center gap-1" title={sessionLive ? "Live session" : "Session"}>
              {sessionLive ? <StatusDot color="var(--success)" pulse /> : null}
              <SquareTerminal size={13} style={{ color: sessionLive ? "var(--success)" : "var(--text-tertiary)" }} />
            </span>
          ) : null}
        </div>
      ) : null}
      {startError ? (
        <span className="text-xs" style={{ color: "var(--danger)" }}>
          {startError}
        </span>
      ) : null}
    </div>
  );

  if (overlay) return cardBody;
  return <ContextMenu items={menuItems}>{cardBody}</ContextMenu>;
}
