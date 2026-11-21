import type { CSSProperties } from "react";
import { TERMINAL_ATTENTION_COPY, type TerminalAttention } from "./attention.js";

/** One shared card and copy for web shell portals and the native Terminal window. */
export function TerminalAttentionCard({ alert, onOpen, onDismiss, style }: {
  alert: TerminalAttention; onOpen(): void; onDismiss(): void; style?: CSSProperties;
}) {
  return <div role={alert.kind === "done" ? "status" : "alert"} data-testid="terminal-attention"
    className="pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-lg backdrop-blur-md"
    style={{ width: "100%", maxWidth: "min(92vw,560px)", background: "var(--bg-app, var(--card, #fff))",
      color: "var(--text-primary, var(--foreground, #171717))", borderColor: "var(--border-default, var(--border, #d4d4d4))", ...style }}>
    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: alert.kind === "done" ? "#10b981" : "#f59e0b" }} />
    <span className="min-w-0 flex-1 truncate"><span className="font-medium">{alert.name}</span> {TERMINAL_ATTENTION_COPY[alert.kind]}
      {alert.message ? <span style={{ opacity: 0.75 }}>: {alert.message}</span> : null}</span>
    <button type="button" className="shrink-0 rounded px-2 py-1 text-xs font-medium hover:bg-black/5" onClick={onOpen}>Open</button>
    <button type="button" aria-label={`Dismiss ${alert.name}`} className="shrink-0 rounded px-1.5 py-1 text-xs hover:bg-black/5" onClick={onDismiss}>×</button>
  </div>;
}
