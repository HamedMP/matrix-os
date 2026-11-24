// Spec 2710 J3-J6: a teammate's shared pane header: who is here and typing,
// who pressed Enter last, this person's role, and whether the owner has control.
import { useSyncExternalStore } from "react";
import { ParticipantAvatars } from "../share/TeamPaneControl";
import { subscribeTeamSessions, teamSession, type TeamSessionState } from "./team-session-store";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const REJECTED_SHOWN_MS = 4_000;

/** Who submitted the last line, and how long ago, from content-free marks. */
export function lastSubmitted(state: TeamSessionState | undefined, now: number): string | null {
  const mark = state?.presence?.marks.filter((entry) => entry.enter).at(-1);
  if (!mark) return null;
  const who = state?.presence?.participants.find((participant) => participant.actorId === mark.actorId)?.displayName ?? "Someone";
  const seconds = Math.max(0, Math.round((now - Date.parse(mark.at)) / 1000));
  const ago = seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
  return `${who} pressed Enter · ${ago}`;
}

export function teamPaneNotice(state: TeamSessionState | undefined, now: number): string | null {
  if (state?.ended) return "You no longer have access, or the terminal ended.";
  const rejected = state?.rejected;
  if (rejected && now - rejected.at < REJECTED_SHOWN_MS) {
    if (rejected.code === "input_paused") return "The owner has control. Your typing is paused.";
    if (rejected.code === "rate_limited") return "Typing too fast. Some input was dropped.";
    return "You can watch but not type in this terminal.";
  }
  if (state?.presence?.inputMode === "owner") return "The owner has control.";
  return null;
}

export function useTeamSession(scopeId: string): TeamSessionState | undefined {
  return useSyncExternalStore(subscribeTeamSessions, () => teamSession(scopeId));
}

export function TeamPaneBar({ scopeId, now }: { scopeId: string; now: number }) {
  const state = useTeamSession(scopeId);
  const notice = teamPaneNotice(state, now);
  const last = lastSubmitted(state, now);
  const viewer = state?.projection?.role === "viewer";
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5">
      {viewer ? <span className="shrink-0 rounded px-1 text-[10px]" style={{ border: "1px solid var(--border-default)" }}>View only</span> : null}
      {notice ? <span role="status" className="min-w-0 truncate text-[11px]" style={{ color: "var(--color-warning, #f59e0b)" }}>{notice}</span>
        : last ? <span className="min-w-0 truncate text-[11px]" style={secondaryText}>{last}</span> : null}
      {state?.presence ? <ParticipantAvatars participants={state.presence.participants} /> : null}
    </span>
  );
}
