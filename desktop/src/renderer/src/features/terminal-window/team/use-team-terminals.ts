// Spec 2710 J2: the Team section's list, refreshed when the window regains
// focus and every 30 s while visible, plus opening a pending share.
import { useCallback, useEffect, useRef, useState } from "react";
import { onEvent } from "../../../lib/operator";
import { registerAlternateTerminalSockets } from "../../terminal/terminal-runtime";
import type { TeamCollaboration } from "../share/use-team-collaboration";
import { acceptTeamTerminal, listTeamTerminals, openTeamComputerTab, TEAM_SESSION_PREFIX, type TeamTerminal } from "./team-terminals";
import { clearTeamSessions, updateTeamSession } from "./team-session-store";
import { createTeamTerminalSocket } from "./team-terminal-socket";

const REFRESH_MS = 30_000;

export type TeamTerminalsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; terminals: TeamTerminal[] };

export function useTeamTerminals(team: TeamCollaboration, enabled: boolean) {
  const [state, setState] = useState<TeamTerminalsState>({ status: "idle" });
  const generation = useRef(0);

  // Team panes stream through this window's collaboration client.
  useEffect(() => {
    const unregister = registerAlternateTerminalSockets(TEAM_SESSION_PREFIX, (sessionName, events) => createTeamTerminalSocket(team.api, sessionName, events));
    return () => { unregister(); clearTeamSessions(); };
  }, [team]);

  const load = useCallback(async (quiet = false) => {
    const api = team.api();
    if (!enabled || !api) return;
    const current = ++generation.current;
    if (!quiet) setState({ status: "loading" });
    try {
      const terminals = await listTeamTerminals(api);
      if (current !== generation.current) return;
      for (const terminal of terminals) if (terminal.kind === "ready") updateTeamSession(terminal.scopeId, { projection: terminal.projection });
      setState({ status: "ready", terminals });
    } catch (error: unknown) {
      if (current !== generation.current) return;
      console.warn("[terminal-window] team terminals unavailable:", error instanceof Error ? error.name : "UnknownError");
      // A refresh that fails keeps what is shown: access is re-checked when a terminal opens.
      if (!quiet) setState({ status: "failed" });
    }
  }, [enabled, team]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the list belongs to the signed-in session and follows focus and a slow timer, like the computer list.
  useEffect(() => {
    if (!enabled) { setState({ status: "idle" }); return; }
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const stopFocus = onEvent("window:focus-changed", ({ focused }) => { if (focused) refresh(); });
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      generation.current += 1;
      clearInterval(timer);
      stopFocus();
    };
  }, [enabled, load]);

  /** Accepts a pending share, then lists again so it opens with its real access. */
  const accept = useCallback(async (terminal: Extract<TeamTerminal, { kind: "pending" }>): Promise<boolean> => {
    const api = team.api();
    if (!api) return false;
    try {
      await acceptTeamTerminal(api, terminal);
      await load(true);
      return true;
    } catch (error: unknown) {
      console.warn("[terminal-window] team share accept failed:", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }, [load, team]);

  /** Opens a new tab on a shared computer, joins it, and returns it to show. */
  const openTab = useCallback(async (fromScopeId: string): Promise<string | null> => {
    const api = team.api();
    if (!api) return null;
    try {
      const scopeId = await openTeamComputerTab(api, fromScopeId);
      const terminals = await listTeamTerminals(api);
      const created = terminals.find((terminal) => terminal.scopeId === scopeId);
      if (created?.kind === "pending") await acceptTeamTerminal(api, created);
      await load(true);
      return scopeId;
    } catch (error: unknown) {
      console.warn("[terminal-window] shared computer tab failed:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, [load, team]);

  return { state, retry: () => { void load(); }, accept, openTab };
}
