import { useEffect, useState } from "react";
import { botInteractionCard, botSavedAnswerRecovery, type BotInteraction } from "@matrix-os/contracts";

/** Expiry reveals the retained draft; it never approves, denies or creates a review. */
export function useRoutineReviewClosed(interaction: BotInteraction | null): boolean {
  const [clock, setClock] = useState(() => Date.now());
  const now = new Date().toISOString();
  const recovery = interaction ? botSavedAnswerRecovery(interaction, now, null) : null;
  const closed = Boolean(interaction && botInteractionCard(interaction, now).state !== "actionable" && (!recovery || recovery.expired));
  useEffect(() => {
    if (!interaction || closed) return;
    const remaining = Date.parse(interaction.expiresAt) - Date.now();
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, Math.min(remaining + 1, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [interaction, closed, clock]);
  return closed;
}
