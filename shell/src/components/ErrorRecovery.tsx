"use client";

import { useState } from "react";

export function ErrorRecovery({ title, description, details, onRetry, onRepair }: {
  title: string;
  description: string;
  details: string;
  onRetry: () => void;
  onRepair: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [expanded, setExpanded] = useState(false);

  async function repair() {
    if (status === "sending") return;
    setStatus("sending");
    try {
      await onRepair();
      setStatus("sent");
    } catch (error: unknown) {
      console.warn("[error-recovery] repair chat failed", error instanceof Error ? error.name : "UnknownError");
      setStatus("failed");
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-md flex-col rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-lg" role="alert">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Matrix OS</p>
      <h2 className="mt-3 text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button type="button" onClick={() => void repair()} disabled={status === "sending"}
          className="min-h-11 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60">
          {status === "sending" ? "Opening repair chat…" : status === "sent" ? "Repair chat opened" : "Fix with Matrix"}
        </button>
        <button type="button" onClick={onRetry}
          className="min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Try again
        </button>
        <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}
          className="min-h-11 rounded-xl px-4 py-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Details
        </button>
      </div>
      {status === "failed" ? <p role="status" className="mt-3 text-sm text-destructive">Could not open a repair chat. Try again.</p> : null}
      {status === "sent" ? <p role="status" className="mt-3 text-sm text-muted-foreground">Matrix received the error context. You can retry the app now.</p> : null}
      {expanded ? <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">{details}</pre> : null}
    </section>
  );
}
