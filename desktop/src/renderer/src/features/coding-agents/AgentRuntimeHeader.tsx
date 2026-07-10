import { Bot, RefreshCw } from "lucide-react";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { Button, StatusDot } from "../../design/primitives";

const STATUS_COLOR: Record<string, string> = {
  available: "var(--success)",
  degraded: "var(--warning)",
  offline: "var(--danger)",
  unknown: "var(--text-tertiary)",
};

export function AgentRuntimeHeader({
  summary,
  onRefresh,
}: {
  summary: RuntimeSummary;
  onRefresh: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-between border-b px-5 py-4"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-md"
          style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
        >
          <Bot size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Agent workspace
          </h1>
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            <StatusDot
              color={STATUS_COLOR[summary.runtime.status] ?? "var(--text-tertiary)"}
              pulse={summary.runtime.status === "available"}
            />
            <span className="truncate">{summary.runtime.label}</span>
          </div>
        </div>
      </div>
      <Button variant="ghost" onClick={onRefresh} aria-label="Refresh agent workspace">
        <RefreshCw size={14} />
        Refresh
      </Button>
    </div>
  );
}
