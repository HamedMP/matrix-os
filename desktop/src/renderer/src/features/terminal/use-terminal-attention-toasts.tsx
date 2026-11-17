import { useEffect, useEffectEvent, useRef } from "react";
import { toast } from "sonner";
import { TerminalAttentionCard, type TerminalAttention } from "@matrix-os/ui/terminal-agents";

/**
 * Shows terminal attention through the window's one toast host (sonner's Toaster),
 * keyed by alert so a repeated request updates its card in place. The alert list
 * stays the source of truth: cards that left it are dismissed, and closing a card
 * dismisses its alert.
 */
export function useTerminalAttentionToasts(
  alerts: readonly TerminalAttention[],
  onOpen: (alert: TerminalAttention) => void,
  dismiss: (key: string) => void,
): void {
  // At most the visible alerts (three) are tracked.
  const shown = useRef(new Set<string>());
  const open = useEffectEvent((alert: TerminalAttention) => { onOpen(alert); dismiss(alert.key); });
  const close = useEffectEvent((key: string) => dismiss(key));

  useEffect(() => {
    const keys = new Set(alerts.map((alert) => alert.key));
    for (const key of shown.current) if (!keys.has(key)) toast.dismiss(key);
    for (const alert of alerts) {
      toast.custom(() => (
        <TerminalAttentionCard alert={alert} onOpen={() => open(alert)} onDismiss={() => close(alert.key)} />
      ), { id: alert.key, duration: Number.POSITIVE_INFINITY, onDismiss: () => close(alert.key) });
    }
    shown.current = keys;
  }, [alerts]);

  useEffect(() => () => {
    for (const key of shown.current) toast.dismiss(key);
  }, []);
}
