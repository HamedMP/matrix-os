"use client";

import { useEffect, useRef, useState } from "react";
import {
  terminalAttentionChanges,
  type TerminalAttention,
  type TerminalTabFacts,
} from "@matrix-os/ui/terminal-agents";
import { OPEN_PROVIDER_TERMINAL_EVENT } from "@/lib/canonical-provider-setup";
import { useTerminalAgentEvents } from "@/stores/terminal-agent-events";
import { ShellNotificationCard } from "../ShellNotificationCard";
import { ShellNotificationPortal } from "../ShellNotificationPortal";

const MAX_VISIBLE = 3;
const DONE_TIMEOUT_MS = 12_000;

const COPY: Record<TerminalAttention["kind"], string> = {
  blocked: "needs you",
  error: "reported an error",
  done: "finished",
};

function personIsLooking(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Herdr-style attention: a toast when an agent in any terminal is blocked or
 * errors, and when one finishes while the person isn't looking. Clicking Open
 * focuses that terminal tab in the current OS view.
 */
export function TerminalAttentionNotifier() {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const retain = useTerminalAgentEvents((state) => state.retain);
  const previous = useRef<ReadonlyMap<string, TerminalTabFacts> | null>(null);
  const [alerts, setAlerts] = useState<TerminalAttention[]>([]);

  useEffect(() => retain(), [retain]);

  useEffect(() => {
    const next = new Map(Object.entries(tabs));
    const before = previous.current;
    previous.current = next;
    // The first snapshot is the current state, not news.
    if (!before) return;
    const seen = personIsLooking() ? new Set(next.keys()) : new Set<string>();
    const changes = terminalAttentionChanges(before, next, seen);
    setAlerts((current) => {
      const stillAlerting = current.filter((alert) => {
        const facts = next.get(alert.key);
        return facts?.state === "live" && facts.agentStatus === alert.kind;
      });
      const fresh = changes.filter((change) => !stillAlerting.some((alert) => alert.key === change.key));
      return [...fresh, ...stillAlerting].slice(0, MAX_VISIBLE);
    });
  }, [tabs]);

  useEffect(() => {
    if (!alerts.some((alert) => alert.kind === "done")) return;
    const timer = setTimeout(() => {
      setAlerts((current) => current.filter((alert) => alert.kind !== "done"));
    }, DONE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [alerts]);

  if (alerts.length === 0) return null;

  const dismiss = (key: string) => setAlerts((current) => current.filter((alert) => alert.key !== key));
  const open = (alert: TerminalAttention) => {
    window.dispatchEvent(new CustomEvent(OPEN_PROVIDER_TERMINAL_EVENT, { detail: { sessionId: alert.key } }));
    dismiss(alert.key);
  };

  return (
    <ShellNotificationPortal>
      {alerts.map((alert) => (
        <ShellNotificationCard
          key={alert.key}
          role={alert.kind === "done" ? "status" : "alert"}
          data-testid="terminal-attention"
          className="flex items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-2.5 text-sm text-foreground shadow-lg backdrop-blur-md"
        >
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${alert.kind === "done" ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{alert.name}</span> {COPY[alert.kind]}
            {alert.message ? <span className="text-muted-foreground">: {alert.message}</span> : null}
          </span>
          <button type="button" className="shrink-0 rounded px-2 py-1 text-xs font-medium hover:bg-muted" onClick={() => open(alert)}>
            Open
          </button>
          <button
            type="button"
            aria-label={`Dismiss ${alert.name}`}
            className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => dismiss(alert.key)}
          >
            ×
          </button>
        </ShellNotificationCard>
      ))}
    </ShellNotificationPortal>
  );
}
