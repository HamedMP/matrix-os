import type { RoutineChatOriginHistoryItem, RoutineChatOriginView } from "@matrix-os/contracts";
import { routineApprovalPreview } from "../chat-agents/bots/routine-presentation.js";

type TimelineRow = { id: string; anchorMessageId?: string; boundary?: boolean };

/** Keep the approval with its source turn, including after the decision changes. */
export function routineApprovalPlacement(view: RoutineChatOriginView | null, rows: readonly TimelineRow[]): {
  after: ReadonlyMap<string, readonly RoutineChatOriginHistoryItem[]>;
  earlier: readonly RoutineChatOriginHistoryItem[];
  currentChanges: readonly RoutineChatOriginHistoryItem[];
} {
  const after = new Map<string, readonly RoutineChatOriginHistoryItem[]>();
  if (!view) return { after, earlier: [], currentChanges: [] };
  const history = view.history ?? [];
  const historicalIds = new Set(history.map(item => item.interaction.interactionId));
  const pending: RoutineChatOriginHistoryItem[] = [];
  const currentChanges: RoutineChatOriginHistoryItem[] = [];
  for (const item of view.pending) {
    if (historicalIds.has(item.interaction.interactionId)) continue;
    const payload = item.interaction.payload;
    // A Schedules edit references the original creation for authority, but it
    // has no new source turn. Keep its live review out of that earlier turn.
    if (payload?.kind === "approval" && routineApprovalPreview(payload.preview)?.source.routineId) currentChanges.push(item);
    else pending.push(item);
  }
  const byAnchor = new Map<string, RoutineChatOriginHistoryItem[]>();
  const inOrder = [...history].reverse().concat([...pending].reverse()).sort((a, b) =>
    (a.createdAt ? Date.parse(a.createdAt) : 0) - (b.createdAt ? Date.parse(b.createdAt) : 0));
  for (const item of inOrder) {
    const items = byAnchor.get(item.anchorMessageId) ?? [];
    items.push(item);
    byAnchor.set(item.anchorMessageId, items);
  }
  let end = rows.at(-1)?.id;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const anchor = row.anchorMessageId ?? row.id;
    const items = byAnchor.get(anchor);
    if (items && end !== undefined) {
      after.set(end, [...items, ...(after.get(end) ?? [])]);
      byAnchor.delete(anchor);
    }
    if (row.boundary) end = rows[index - 1]?.id;
  }
  // Keep an older outstanding decision reachable. Its historical card appears
  // only when the owning turn is loaded, rather than in an unrelated turn.
  return { after, earlier: pending.filter(item => byAnchor.has(item.anchorMessageId)), currentChanges };
}

export function routineOriginHistoryStatus(item: RoutineChatOriginHistoryItem): string | undefined {
  switch (item.interaction.status) {
    case "pending": return undefined;
    case "cancelled": return "Cancelled";
    case "expired": return "Expired";
    case "resolved": return item.decision === "approve" ? "Approved" : item.decision === "deny" ? "Declined" : "Resolved";
  }
}
