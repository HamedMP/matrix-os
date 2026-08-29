import type {
  CanonicalChatDetailResponse,
  RuntimeSummary,
  TerminalSessionSummary,
} from "@matrix-os/contracts";

const MAX_CHAT_ACTIVITIES = 500;

export function projectWorkTerminalSessions(
  detail: CanonicalChatDetailResponse,
  summary: RuntimeSummary | null,
): TerminalSessionSummary[] {
  const liveById = new Map(
    (summary?.terminalSessions?.items ?? []).slice(0, 50).map((session) => [session.id, session]),
  );
  const seen = new Set<string>();
  const sessions: TerminalSessionSummary[] = [];

  for (const sessionId of [...(detail.terminalSessionIds ?? [])].reverse()) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const live = liveById.get(sessionId);
    sessions.push(live ?? {
      id: sessionId,
      name: sessionId,
      status: "unavailable",
      attachable: false,
      createdAt: detail.record.chat.updatedAt,
      updatedAt: detail.record.chat.updatedAt,
    });
  }

  for (const activity of detail.activities.slice(-MAX_CHAT_ACTIVITIES).reverse()) {
    if (activity.type !== "terminal.bound" || seen.has(activity.terminalSessionId)) continue;
    seen.add(activity.terminalSessionId);
    const live = liveById.get(activity.terminalSessionId);
    sessions.push(live ?? {
      id: activity.terminalSessionId,
      name: activity.terminalSessionId,
      status: "unavailable",
      attachable: false,
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    });
  }

  return sessions;
}
