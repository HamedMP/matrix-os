import type { CanonicalChatInspectorProjection } from "@matrix-os/contracts";
import {
  Activity,
  FileDiff,
  Files,
  FolderKanban,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { InspectorTabShell, type InspectorTabDefinition } from "./InspectorTabShell";

export type ChatInspectorTab = "context" | "run" | "approvals" | "changes" | "files";

interface ChatInspectorApprovals {
  count: number;
  content: ReactNode;
}

interface ChatInspectorReadyProps {
  state: "ready";
  projection: CanonicalChatInspectorProjection;
  approvals?: ChatInspectorApprovals;
  defaultTab?: ChatInspectorTab;
  selectedTab?: ChatInspectorTab;
  onTabChange?: (tab: ChatInspectorTab) => void;
  headerActions?: ReactNode;
}

interface ChatInspectorPendingProps {
  state: "loading" | "empty" | "error";
  projection?: never;
  approvals?: never;
  defaultTab?: never;
  selectedTab?: never;
  onTabChange?: never;
  headerActions?: ReactNode;
}

export type ChatInspectorProps = ChatInspectorReadyProps | ChatInspectorPendingProps;

const STATUS_COPY = {
  loading: "Loading chat details…",
  empty: "Select a chat to inspect its context and activity.",
  error: "Chat details couldn't be loaded. Try again.",
} as const;

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function modelLabel(model: string): string {
  const parts = model.split("-");
  return parts.map((part, index) => {
    if (index === 0 && part.toLowerCase() === "gpt") return "GPT";
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join("-");
}

function DetailCard({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <section
      className="rounded-lg border p-3"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
        <Icon size={14} aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function ValueRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <dt style={{ color: "var(--text-tertiary)" }}>{label}</dt>
      <dd className="min-w-0 text-right font-medium" style={{ color: "var(--text-primary)" }}>{value}</dd>
    </div>
  );
}

function ContextPanel({ projection }: { projection: CanonicalChatInspectorProjection }) {
  const { project, executionRoot } = projection.context;
  return (
    <div className="grid gap-3">
      <DetailCard title="Project context" icon={FolderKanban}>
        {project ? (
          <dl>
            <ValueRow label="Project" value={project.name} />
            <ValueRow label="Type" value={titleCase(project.kind)} />
            {project.repositoryLabel ? <ValueRow label="Repository" value={project.repositoryLabel} /> : null}
            <ValueRow label="Status" value={titleCase(project.status)} />
          </dl>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>This Chat is not attached to a Project.</p>
        )}
      </DetailCard>
      <DetailCard title="Execution context" icon={Activity}>
        {executionRoot ? (
          <dl>
            <ValueRow
              label="Workspace"
              value={executionRoot.kind === "worktree" ? "Project worktree" : "Project workspace"}
            />
            {projection.terminals.length > 0 ? (
              <ValueRow label="Terminal sessions" value={projection.terminals.length} />
            ) : null}
          </dl>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>No execution workspace is available.</p>
        )}
      </DetailCard>
    </div>
  );
}

function RunPanel({ projection }: { projection: CanonicalChatInspectorProjection }) {
  const run = projection.run;
  if (!run) return null;
  return (
    <DetailCard title="Run details" icon={Activity}>
      <dl>
        <ValueRow label="Status" value={titleCase(run.status)} />
        <ValueRow label="Provider" value={titleCase(run.driverKind)} />
        <ValueRow label="Model" value={modelLabel(run.model)} />
        {run.startedAt ? <ValueRow label="Started" value={<time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>} /> : null}
        {run.completedAt ? <ValueRow label="Completed" value={<time dateTime={run.completedAt}>{new Date(run.completedAt).toLocaleString()}</time>} /> : null}
      </dl>
    </DetailCard>
  );
}

function ChangesPanel({ projection }: { projection: CanonicalChatInspectorProjection }) {
  const changes = projection.changes;
  if (changes.availability === "unavailable") {
    const copy = {
      not_supported: "This Provider does not expose canonical change details.",
      not_ready: "Change details are not ready yet.",
      run_incomplete: "Change details will be available after the Run settles.",
      history_only: "This imported Chat has history without canonical change details.",
    }[changes.reason];
    return <p className="rounded-lg border p-3 text-sm" role="status" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>{copy}</p>;
  }
  return (
    <div className="grid gap-3">
      <DetailCard title="Turn changes" icon={FileDiff}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <strong style={{ color: "var(--text-primary)" }}>
            {changes.changedFileCount} changed {changes.changedFileCount === 1 ? "file" : "files"}
          </strong>
          <span style={{ color: "var(--success)" }}>+{changes.additions}</span>
          <span style={{ color: "var(--danger)" }}>-{changes.deletions}</span>
          {changes.partial ? <span className="rounded-full border px-2 py-0.5 text-xs" style={{ borderColor: "var(--warning)", color: "var(--warning)" }}>Partial</span> : null}
        </div>
      </DetailCard>
      <ul className="grid gap-2">
        {changes.files.map((file) => (
          <li key={file.resource.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
            <span className="min-w-0 truncate" style={{ color: "var(--text-primary)" }}>{file.resource.label}</span>
            <span className="shrink-0 text-xs" style={{ color: "var(--text-tertiary)" }}>{titleCase(file.changeKind)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesPanel({ projection }: { projection: CanonicalChatInspectorProjection }) {
  return (
    <ul className="grid gap-2">
      {projection.files.map((file) => (
        <li key={`${file.kind}:${file.id}`} className="rounded-md border px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
          <p className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{file.label}</p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>{titleCase(file.kind)}</p>
        </li>
      ))}
    </ul>
  );
}

function pendingState(state: ChatInspectorPendingProps["state"]): ReactNode {
  return (
    <div className="flex min-h-48 flex-1 items-center justify-center p-6 text-center">
      <p
        role={state === "error" ? "alert" : state === "loading" ? "status" : undefined}
        className="max-w-xs text-sm"
        style={{ color: state === "error" ? "var(--danger)" : "var(--text-secondary)" }}
      >
        {STATUS_COPY[state]}
      </p>
    </div>
  );
}

export function ChatInspector(props: ChatInspectorProps) {
  if (props.state !== "ready") {
    return (
      <aside aria-label="Chat details" className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: "var(--bg-sunken)" }}>
        {pendingState(props.state)}
      </aside>
    );
  }

  const { projection } = props;
  const tabs: Array<InspectorTabDefinition<ChatInspectorTab>> = [
    { id: "context", label: "Context", icon: FolderKanban, content: <ContextPanel projection={projection} /> },
    ...(projection.run ? [{ id: "run" as const, label: "Run", icon: Activity, content: <RunPanel projection={projection} /> }] : []),
    ...(props.approvals ? [{ id: "approvals" as const, label: "Approvals", icon: ShieldCheck, count: props.approvals.count, content: props.approvals.content }] : []),
    {
      id: "changes",
      label: "Changes",
      icon: FileDiff,
      count: projection.changes.availability === "available" ? projection.changes.changedFileCount : undefined,
      content: <ChangesPanel projection={projection} />,
    },
    ...(projection.files.length > 0 ? [{ id: "files" as const, label: "Files", icon: Files, count: projection.files.length, content: <FilesPanel projection={projection} /> }] : []),
  ];
  const defaultTab = props.defaultTab && tabs.some((tab) => tab.id === props.defaultTab)
    ? props.defaultTab
    : "context";

  return (
    <aside aria-label="Chat details" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ background: "var(--bg-sunken)" }}>
      <InspectorTabShell
        ariaLabel="Chat details"
        tabs={tabs}
        defaultTab={defaultTab}
        selectedTab={props.selectedTab}
        onTabChange={props.onTabChange}
        header={(
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Chat details</h2>
              <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>Context and activity for this Chat</p>
            </div>
            {props.headerActions}
          </div>
        )}
      />
    </aside>
  );
}
