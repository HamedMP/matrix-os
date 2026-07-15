import { Bell, ChevronRight, GitBranch } from "lucide-react";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { StatusDot } from "../../design/primitives";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { AgentWorkspaceSection as Section } from "./AgentWorkspaceSection";

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
type NotificationPreferenceKey = "approval" | "input" | "failed" | "completed";

export function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

export function InspectorEmptyState({ message }: { message: string }) {
  return (
    <p
      className="rounded-md border p-3 text-sm"
      style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)", background: "var(--bg-surface)" }}
    >
      {message}
    </p>
  );
}

const NOTIFICATION_TOGGLES: Array<{ key: NotificationPreferenceKey; label: string; detail: string }> = [
  { key: "approval", label: "Approval alerts", detail: "Approval-required runs" },
  { key: "input", label: "Input request alerts", detail: "Runs waiting for a response" },
  { key: "failed", label: "Failed run alerts", detail: "Runs that need recovery" },
  { key: "completed", label: "Completion alerts", detail: "Runs that finish successfully" },
];

export function NotificationPreferencesPanel() {
  const status = useCodingAgentWorkspace((s) => s.notificationPreferencesStatus);
  const preferences = useCodingAgentWorkspace((s) => s.notificationPreferences);
  const error = useCodingAgentWorkspace((s) => s.notificationPreferencesError);
  const updateNotificationPreferences = useCodingAgentWorkspace((s) => s.updateNotificationPreferences);
  const disabled = status === "loading" || status === "saving" || !preferences;

  return (
    <Section title="Notifications">
      <div
        className="grid gap-2 rounded-md border p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        {NOTIFICATION_TOGGLES.map((item) => (
          <label
            key={item.key}
            className="flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2"
            style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Bell size={14} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.label}</span>
                <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {item.detail}
                </span>
              </span>
            </span>
            <input
              aria-label={item.label}
              type="checkbox"
              className="h-4 w-4 shrink-0"
              checked={Boolean(preferences?.attentionPush[item.key])}
              disabled={disabled}
              onChange={(event) => {
                if (!preferences) return;
                void updateNotificationPreferences({
                  attentionPush: { [item.key]: event.currentTarget.checked },
                });
              }}
            />
          </label>
        ))}
        {error ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

export function ProviderList({ summary }: { summary: RuntimeSummary }) {
  return (
    <Section title="Providers" count={summary.providers.length}>
      <div className="grid gap-2">
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

type RuntimeAttentionThread = RuntimeSummary["attentionThreads"]["items"][number];

function threadAttentionLabel(attention: RuntimeAttentionThread["attention"]): string | null {
  switch (attention) {
    case "approval_required":
      return "Approval needed";
    case "input_required":
      return "Input needed";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    default:
      return null;
  }
}

export function AttentionThreadList({ summary }: { summary: RuntimeSummary }) {
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);

  return (
    <Section title="Needs Attention" count={summary.attentionThreads.items.length}>
      <div className="grid gap-2">
        {summary.attentionThreads.items.map((thread) => {
          const active = activeThreadId === thread.id;
          const attentionLabel = threadAttentionLabel(thread.attention) ?? thread.status.replace(/_/g, " ");

          return (
            <button
              key={thread.id}
              type="button"
              aria-current={active ? "true" : undefined}
              aria-label={`Open details for ${thread.title}, ${attentionLabel}`}
              className="no-drag flex min-h-[68px] w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors duration-100 hover:brightness-105"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border-subtle)",
                background: active ? "var(--accent-muted)" : "var(--bg-surface)",
              }}
              onClick={() => void loadThreadSnapshot(thread.id)}
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
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
                  {attentionLabel}
                </span>
                <ChevronRight size={14} style={{ color: "var(--text-tertiary)" }} />
              </div>
            </button>
          );
        })}
        {summary.attentionThreads.items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No attention needed.
          </p>
        ) : null}
      </div>
    </Section>
  );
}
