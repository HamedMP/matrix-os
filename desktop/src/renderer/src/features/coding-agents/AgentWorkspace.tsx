import { Bot, GitBranch, RefreshCw, Server, SquareTerminal } from "lucide-react";
import { useEffect } from "react";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { Button, EmptyState, StatusDot } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";

const STATUS_COLOR: Record<string, string> = {
  available: "var(--success)",
  running: "var(--success)",
  installed: "var(--success)",
  authenticated: "var(--success)",
  degraded: "var(--warning)",
  setup_required: "var(--warning)",
  auth_required: "var(--warning)",
  missing: "var(--warning)",
  offline: "var(--danger)",
  failed: "var(--danger)",
  unavailable: "var(--danger)",
  unknown: "var(--text-tertiary)",
};
const DEFAULT_STATUS_COLOR = "var(--text-tertiary)";

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {title}
        </h2>
        {typeof count === "number" ? (
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function RuntimeHeader({ summary, onRefresh }: { summary: RuntimeSummary; onRefresh: () => void }) {
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
            <StatusDot color={STATUS_COLOR[summary.runtime.status] ?? DEFAULT_STATUS_COLOR} pulse={summary.runtime.status === "available"} />
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

function ProviderList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Providers" count={summary.providers.length}>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {summary.providers.map((provider) => (
          <article
            key={provider.id}
            className="rounded-md border p-3"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {provider.displayName}
                </h3>
                <p className="text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
                  {provider.kind}
                </p>
              </div>
              <StatusDot color={STATUS_COLOR[provider.availability] ?? DEFAULT_STATUS_COLOR} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt style={{ color: "var(--text-tertiary)" }}>Install</dt>
                <dd style={{ color: "var(--text-secondary)" }}>{provider.installStatus.replace(/_/g, " ")}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--text-tertiary)" }}>Auth</dt>
                <dd style={{ color: "var(--text-secondary)" }}>{provider.authStatus.replace(/_/g, " ")}</dd>
              </div>
            </dl>
          </article>
        ))}
        {summary.providers.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No providers are ready.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function ThreadList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Active Threads" count={summary.activeThreads.items.length}>
      <div className="grid gap-2">
        {summary.activeThreads.items.map((thread) => (
          <article
            key={thread.id}
            className="flex items-center justify-between gap-3 rounded-md border p-3"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch size={15} style={{ color: "var(--text-tertiary)" }} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {thread.title}
                </h3>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {thread.providerId}
                </p>
              </div>
            </div>
            <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
              {thread.status.replace(/_/g, " ")}
            </span>
          </article>
        ))}
        {summary.activeThreads.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No active threads.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function TerminalList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Terminals" count={summary.terminalSessions.items.length}>
      <div className="grid gap-2">
        {summary.terminalSessions.items.map((session) => (
          <article
            key={session.id}
            className="flex items-center justify-between gap-3 rounded-md border p-3"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <SquareTerminal size={15} style={{ color: "var(--text-tertiary)" }} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {session.name}
                </h3>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {session.attachable ? "Attachable" : "Unavailable"}
                </p>
              </div>
            </div>
            <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
              {session.status}
            </span>
          </article>
        ))}
        {summary.terminalSessions.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No terminal sessions.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

export default function AgentWorkspace() {
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const status = useCodingAgentWorkspace((s) => s.status);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const error = useCodingAgentWorkspace((s) => s.error);
  const refresh = useCodingAgentWorkspace((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh, runtimeSlot]);

  if (status === "loading" && !summary) {
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline="Loading workspace..."
        description="Fetching runtime state from your Matrix computer."
      />
    );
  }

  if (status === "error" && !summary) {
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline={error ?? "Runtime summary unavailable"}
        description="Refresh the workspace or check your selected runtime."
        action={<Button onClick={() => void refresh()}>Retry</Button>}
      />
    );
  }

  if (!summary) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RuntimeHeader summary={summary} onRefresh={() => void refresh()} />
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5">
        <ProviderList summary={summary} />
        <div className="grid gap-4 xl:grid-cols-2">
          <ThreadList summary={summary} />
          <TerminalList summary={summary} />
        </div>
      </div>
    </div>
  );
}
