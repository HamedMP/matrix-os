"use client";

import { useEffect, useRef, useState } from "react";
import {
  TerminalAttentionCard,
  retainTerminalAttention,
  terminalAttentionChanges,
  type TerminalAttention,
  type TerminalTabFacts,
} from "@matrix-os/ui/terminal-agents";
import { openTerminalSession } from "@/lib/terminal-session-open";
import { useTerminalAgentEvents } from "@/stores/terminal-agent-events";
import { ShellNotificationPortal } from "../ShellNotificationPortal";
import { visibleTerminalSessions } from "./visible-terminal-sessions";

const MAX_VISIBLE = 3;
// Alerts waiting for a free slot; bounded, most recent kept.
const MAX_PENDING = 32;
// Blocked and errored agents need the person; they are shown before completions.
const URGENT = (alert: TerminalAttention) => (alert.kind === "done" ? 1 : 0);
const DONE_TIMEOUT_MS = 12_000;

function sameAlerts(left: TerminalAttention[], right: TerminalAttention[]): boolean {
  return left.length === right.length
    && left.every((alert, index) => alert.key === right[index]!.key && alert.kind === right[index]!.kind
      && alert.name === right[index]!.name && alert.message === right[index]!.message);
}

/**
 * Herdr-style attention: a toast when an agent in any terminal is blocked or
 * errors, and when one finishes while the person isn't looking. Clicking Open
 * focuses that terminal tab in the current OS view.
 */
export function TerminalAttentionNotifier() {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const connected = useTerminalAgentEvents((state) => state.connected);
  const retain = useTerminalAgentEvents((state) => state.retain);
  const previous = useRef<ReadonlyMap<string, TerminalTabFacts> | null>(null);
  const [alerts, setAlerts] = useState<TerminalAttention[]>([]);

  useEffect(() => retain(), [retain]);

  useEffect(() => {
    // Nothing is known until the first snapshot arrives; after a disconnect, the next
    // snapshot is a fresh baseline too, never a batch of news.
    if (!connected) {
      previous.current = null;
      return;
    }
    const next = new Map(Object.entries(tabs));
    const before = previous.current;
    previous.current = next;
    if (!before) {
      // A fresh baseline: keep only alerts this snapshot still supports.
      setAlerts((current) => {
        const kept = retainTerminalAttention(current, next);
        return sameAlerts(current, kept) ? current : kept;
      });
      return;
    }
    const changes = terminalAttentionChanges(before, next, visibleTerminalSessions());
    setAlerts((current) => {
      const stillAlerting = retainTerminalAttention(current, next);
      const fresh = changes.filter((change) => !stillAlerting.some((alert) => alert.key === change.key));
      const updated = [...fresh, ...stillAlerting].slice(0, MAX_PENDING);
      // Unchanged alerts keep their array, so the done timeout is not restarted.
      return sameAlerts(current, updated) ? current : updated;
    });
  }, [tabs, connected]);

  useEffect(() => {
    if (!alerts.some((alert) => alert.kind === "done")) return;
    const timer = setTimeout(() => {
      setAlerts((current) => current.filter((alert) => alert.kind !== "done"));
    }, DONE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [alerts]);

  if (alerts.length === 0) return null;
  // Only the display is limited: hidden alerts wait and show when a slot frees up.
  const visible = alerts.toSorted((left, right) => URGENT(left) - URGENT(right)).slice(0, MAX_VISIBLE);

  const dismiss = (key: string) => setAlerts((current) => current.filter((alert) => alert.key !== key));
  const open = (alert: TerminalAttention) => {
    // The durable Terminal window shows it without taking it over: closing that
    // window must not end the agent.
    openTerminalSession(alert.key);
    dismiss(alert.key);
  };

  return (
    <ShellNotificationPortal>
      {visible.map((alert) => (
        <TerminalAttentionCard key={alert.key} alert={alert} onOpen={() => open(alert)} onDismiss={() => dismiss(alert.key)} />
      ))}
    </ShellNotificationPortal>
  );
}
