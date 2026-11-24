// Spec 2710 J5: in a shared tab's pane header, who is watching, who is
// typing, and the owner's "Take control" / "Hand back" switch.
import { useState } from "react";
import { Share2 } from "lucide-react";
import type { CollaborationTeamTerminalParticipant, TeamTerminalOwnerEntry } from "@matrix-os/contracts";
import { Button } from "../../../design/primitives";
import { COMPACT_ICON_BUTTON, COMPACT_ICON_BUTTON_CLASS } from "../compact-icon-button";

const MAX_AVATARS = 4;
const ROLE_LABEL: Record<CollaborationTeamTerminalParticipant["role"], string> = { owner: "owner", editor: "can type", viewer: "watching" };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** A steady color for a person, so the same teammate looks the same everywhere. */
export function participantColor(actorId: string): string {
  let hash = 0;
  for (const char of actorId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 45%)`;
}

export function ParticipantAvatars({ participants }: { participants: readonly CollaborationTeamTerminalParticipant[] }) {
  const shown = participants.slice(0, MAX_AVATARS);
  const extra = participants.length - shown.length;
  const summary = participants.map((participant) => `${participant.displayName} (${participant.typingAt ? "typing" : ROLE_LABEL[participant.role]})`).join(", ");
  return (
    <span role="img" aria-label={`In this terminal: ${summary}`} title={summary} className="flex shrink-0 items-center">
      {shown.map((participant) => (
        <span key={participant.actorId} aria-hidden="true"
          className="-ml-1 flex size-4 items-center justify-center rounded-full text-[8px] font-bold text-white first:ml-0"
          style={{ background: participantColor(participant.actorId), boxShadow: participant.typingAt ? "0 0 0 2px #3b82f6" : "0 0 0 1px var(--bg-surface)" }}>
          {initials(participant.displayName)}
        </span>
      ))}
      {extra > 0 ? <span aria-hidden="true" className="ml-1 text-[10px]">+{extra}</span> : null}
    </span>
  );
}

export function TeamPaneControl({ entry, title, onShare, onInputMode }: {
  /** Present while teammates watch this tab. */
  entry: TeamTerminalOwnerEntry | undefined;
  title: string;
  onShare(): void;
  onInputMode(scopeId: string, mode: "shared" | "owner"): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!entry || busy) return;
    setBusy(true);
    try { await onInputMode(entry.scopeId, entry.inputMode === "owner" ? "shared" : "owner"); }
    catch (error: unknown) { console.warn("[terminal-window] input mode change failed:", error instanceof Error ? error.name : "UnknownError"); }
    finally { setBusy(false); }
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {entry ? <ParticipantAvatars participants={entry.participants} /> : null}
      {entry ? (
        <Button variant="ghost" disabled={busy} onClick={() => { void toggle(); }}
          title={entry.inputMode === "owner" ? "Let editors type again" : "Only you can type until you hand back"}
          className="h-5 rounded px-1.5 text-[11px]">
          {entry.inputMode === "owner" ? "Hand back" : "Take control"}
        </Button>
      ) : null}
      <Button variant="ghost" aria-label={`Share ${title}`} title="Share with teammates" onClick={onShare}
        className={COMPACT_ICON_BUTTON_CLASS} style={COMPACT_ICON_BUTTON}>
        <Share2 size={12} aria-hidden="true" />
      </Button>
    </span>
  );
}
