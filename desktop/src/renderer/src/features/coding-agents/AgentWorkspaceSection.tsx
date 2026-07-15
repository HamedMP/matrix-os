export function AgentWorkspaceSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
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

export function AgentWorkspaceStack({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="agent-workspace-stack"
      className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
    >
      {children}
    </div>
  );
}
