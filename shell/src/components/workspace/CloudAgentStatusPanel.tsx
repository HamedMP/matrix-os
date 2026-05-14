"use client";

export interface CloudAgentStatusSession {
  id?: string;
  agent?: string;
  status?: string;
  taskId?: string;
  runtime?: { status?: string };
  cloudRuntime?: { status?: string };
}

function effectiveRuntimeStatus(session: CloudAgentStatusSession): string {
  return session.cloudRuntime?.status ?? session.runtime?.status ?? session.status ?? "";
}

export function CloudAgentStatusPanel({ sessions }: { sessions: CloudAgentStatusSession[] }) {
  const running = sessions.filter((session) => effectiveRuntimeStatus(session) === "running").length;
  const attention = sessions.filter((session) => ["blocked", "failed", "attention"].includes(effectiveRuntimeStatus(session))).length;

  return (
    <section className="border-b border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Cloud agents</h2>
        <span className="text-xs text-muted-foreground">{sessions.length} total</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-border px-2 py-1">{running} running</div>
        <div className="rounded-md border border-border px-2 py-1">{attention} needs attention</div>
      </div>
    </section>
  );
}
