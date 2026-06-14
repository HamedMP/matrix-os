import { ArrowLeft, SquareTerminal } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button, EmptyState, IconButton } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import TerminalView from "../terminal/TerminalView";

export default function TaskWorkspace({ taskId }: { taskId: string }) {
  const api = useConnection((s) => s.api);
  const activeSlug = useBoard((s) => s.activeProjectSlug);
  const cardsByProject = useBoard((s) => s.cardsByProject);
  const sessionsLoad = useSessions((s) => s.load);
  const resolveAttachName = useSessions((s) => s.resolveAttachName);
  const navigate = useUi((s) => s.navigate);

  const card = useMemo(() => {
    for (const cards of Object.values(cardsByProject)) {
      const found = cards.find((c) => c.id === taskId);
      if (found) return found;
    }
    return null;
  }, [cardsByProject, taskId]);

  useEffect(() => {
    if (api) void sessionsLoad(api);
  }, [api, sessionsLoad]);

  const attachName = resolveAttachName(card?.linkedSessionId ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <IconButton label="Back to board" onClick={() => navigate({ kind: "board" })}>
          <ArrowLeft size={15} />
        </IconButton>
        <span className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {card?.title ?? "Task"}
        </span>
        {attachName ? (
          <span
            className="rounded-full border px-2 py-0.5 font-mono text-xs"
            style={{ borderColor: "var(--border-default)", color: "var(--text-tertiary)" }}
          >
            {attachName}
          </span>
        ) : null}
      </div>

      {attachName ? (
        <TerminalView sessionName={attachName} />
      ) : (
        <EmptyState
          icon={<SquareTerminal size={28} />}
          headline="No live session"
          description={
            card?.linkedSessionId
              ? "This task's session has ended on your computer."
              : "This task has no linked terminal session yet."
          }
          action={
            activeSlug ? (
              <Button
                variant="primary"
                onClick={() => {
                  if (api) void sessionsLoad(api);
                }}
              >
                Refresh sessions
              </Button>
            ) : null
          }
        />
      )}
    </div>
  );
}
