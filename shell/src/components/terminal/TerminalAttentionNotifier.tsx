"use client";

import { useEffect, useMemo } from "react";
import { TerminalAttentionCard, useTerminalAttention, visibleTerminalSessions, type TerminalAttention } from "@matrix-os/ui/terminal-agents";
import { openTerminalSession } from "@/lib/terminal-session-open";
import { useTerminalAgentEvents } from "@/stores/terminal-agent-events";
import { ShellNotificationPortal } from "../ShellNotificationPortal";

/**
 * Herdr-style attention: a toast when an agent in any terminal is blocked or
 * errors, and when one finishes while the person isn't looking. Clicking Open
 * focuses that terminal tab in the current OS view.
 */
export function TerminalAttentionNotifier() {
  const tabs = useTerminalAgentEvents((state) => state.tabs);
  const connected = useTerminalAgentEvents((state) => state.connected);
  const retain = useTerminalAgentEvents((state) => state.retain);
  useEffect(() => retain(), [retain]);
  // Nothing is known until the first snapshot arrives; after a disconnect, the next
  // snapshot is a fresh baseline too.
  const facts = useMemo(() => (connected ? new Map(Object.entries(tabs)) : null), [tabs, connected]);
  const { visible, dismiss } = useTerminalAttention(facts, visibleTerminalSessions);

  if (visible.length === 0) return null;
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
