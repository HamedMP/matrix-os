// Spec 2710 J2: the Spaces sidebar's Team section. Only terminals a teammate
// explicitly shared with this person appear, under the computer they run on
// ("Nima's team-dev-1"), with this person's role.
import { useState } from "react";
import { Users } from "lucide-react";
import { groupTeamTerminals, roleLabel, teamRowKey, type TeamTerminal } from "./team-terminals";
import type { TeamTerminalsState } from "./use-team-terminals";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const SELECTED_BG = "rgba(127,127,127,0.18)";
const rowClass = "no-drag flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";

function terminalTitle(terminal: TeamTerminal): string {
  if (terminal.kind === "ready") return terminal.projection.terminalName;
  return terminal.kind === "pending" ? "Shared terminal" : "Terminal (offline)";
}

function TeamRow({ terminal, selected, onOpen, onAccept }: {
  terminal: TeamTerminal;
  selected: boolean;
  onOpen(key: string): void;
  onAccept(terminal: Extract<TeamTerminal, { kind: "pending" }>): Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const title = terminalTitle(terminal);
  const open = async () => {
    if (terminal.kind === "ready") { onOpen(teamRowKey(terminal.scopeId)); return; }
    if (terminal.kind !== "pending" || busy) return;
    setBusy(true);
    setFailed(false);
    let accepted = false;
    try {
      accepted = await onAccept(terminal);
    } finally {
      setBusy(false);
    }
    if (accepted) onOpen(teamRowKey(terminal.scopeId));
    else setFailed(true);
  };
  const detail = terminal.kind === "ready"
    ? `${roleLabel(terminal.projection.role)}${terminal.projection.status === "exited" ? " · ended" : ""}`
    : terminal.kind === "pending" ? "Open to join" : "Offline";
  return (
    <li>
      <button type="button" className={rowClass} disabled={busy || terminal.kind === "offline"} aria-current={selected ? "true" : undefined}
        style={selected ? { background: SELECTED_BG } : undefined} onClick={() => { void open(); }}
        title={terminal.kind === "ready" ? `${title} — ${roleLabel(terminal.projection.role)}` : title}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-[11px]" style={secondaryText}>{busy ? "Opening…" : detail}</span>
      </button>
      {failed ? <p role="alert" className="px-2 pb-1 text-[11px]">Couldn't open this share. Try again.</p> : null}
    </li>
  );
}

export function TeamSpaces({ state, selectedKey, onOpen, onAccept, onRetry }: {
  state: TeamTerminalsState;
  selectedKey: string | null;
  onOpen(key: string): void;
  onAccept(terminal: Extract<TeamTerminal, { kind: "pending" }>): Promise<boolean>;
  onRetry(): void;
}) {
  if (state.status === "idle") return null;
  return (
    <section aria-label="Team" className="flex flex-col gap-0.5 px-1.5 pb-1.5">
      <h2 className="flex items-center gap-1.5 px-2 pt-2 text-[11px] font-semibold uppercase tracking-wide" style={secondaryText}>
        <Users size={11} aria-hidden="true" /> Team
      </h2>
      {state.status === "loading" ? <p role="status" className="px-2 text-[12px]" style={secondaryText}>Loading shared terminals…</p> : null}
      {state.status === "failed" ? (
        <div role="alert" className="flex items-center gap-2 px-2 text-[12px]">
          Couldn't load shared terminals.
          <button type="button" className="rounded border px-1.5 py-0.5" style={{ borderColor: "var(--border-default)" }} onClick={onRetry}>Retry</button>
        </div>
      ) : null}
      {state.status === "ready" && state.terminals.length === 0
        ? <p className="px-2 text-[12px]" style={secondaryText}>Terminals teammates share with you appear here.</p> : null}
      {state.status === "ready" ? groupTeamTerminals(state.terminals).map((group) => (
        <div key={group.id}>
          <p className="truncate px-2 pt-1 text-[12px] font-medium">{group.name}</p>
          <ul aria-label={group.name} className="flex flex-col">
            {group.terminals.map((terminal) => (
              <TeamRow key={terminal.scopeId} terminal={terminal} selected={selectedKey === teamRowKey(terminal.scopeId)}
                onOpen={onOpen} onAccept={onAccept} />
            ))}
          </ul>
        </div>
      )) : null}
    </section>
  );
}
