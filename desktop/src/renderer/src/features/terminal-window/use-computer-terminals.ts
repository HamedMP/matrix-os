import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient, type ApiClient } from "../../lib/api";
import { resetAttachManager } from "../terminal/terminal-runtime";
import { onEvent } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import {
  createComputerTab, listComputerTabs, terminalsFailure,
  type ComputerTerminalTab, type ComputerTerminalsFailure,
} from "./computer-terminals";

export type ComputerTerminalsState =
  | { status: "loading" }
  | { status: "ready"; tabs: ComputerTerminalTab[] }
  | { status: "failed"; reason: ComputerTerminalsFailure };

export interface ActiveTerminal { slot: string; refKey: string }

/**
 * Per-computer tab listings plus the one attached terminal. `sessionKey`
 * changes with the signed-in session, which drops every listing and detaches.
 */
export function useComputerTerminals(platformHost: string | null, sessionKey: string) {
  // Keyed by inventory slot (at most 20 computers).
  const [terminals, setTerminals] = useState<Record<string, ComputerTerminalsState>>({});
  const [active, setActive] = useState<ActiveTerminal | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  // The computer whose last "New terminal" did not take effect.
  const [createFailed, setCreateFailed] = useState<string | null>(null);
  const generations = useRef<Record<string, number>>({});
  const boundSlot = useRef<string | null>(null);
  // Counts signed-in sessions seen by this hook. Work started in one session
  // must not open, list or report anything in the next.
  const session = useRef(0);
  // Counts the user's choices of what to show. A terminal that finishes being
  // created is opened only if the user has not chosen something else since.
  const selection = useRef(0);

  const client = useMemo<ApiClient | null>(
    () => (platformHost ? createApiClient({ baseUrl: platformHost, getRuntimeSlot: () => "primary" }) : null),
    [platformHost],
  );

  useEffect(() => {
    // Bump rather than reset: a listing still in flight for the previous
    // session must never match a generation issued to the new one.
    for (const slot of Object.keys(generations.current)) generations.current[slot] = (generations.current[slot] ?? 0) + 1;
    session.current += 1;
    boundSlot.current = null;
    setTerminals({});
    setActive(null);
    setCreating(null);
    setCreateFailed(null);
    resetAttachManager();
    return () => { resetAttachManager(); };
  }, [client, sessionKey]);

  const load = useCallback(async (slot: string) => {
    if (!client) return;
    const generation = (generations.current[slot] ?? 0) + 1;
    generations.current[slot] = generation;
    setTerminals((current) => (current[slot]?.status === "ready" ? current : { ...current, [slot]: { status: "loading" } }));
    try {
      const tabs = await listComputerTabs(client.forRuntime(slot));
      if (generations.current[slot] !== generation) return;
      setTerminals((current) => ({ ...current, [slot]: { status: "ready", tabs } }));
    } catch (error: unknown) {
      if (generations.current[slot] !== generation) return;
      console.warn("[terminal-window] tabs unavailable:", error instanceof Error ? error.name : "UnknownError");
      setTerminals((current) => ({ ...current, [slot]: { status: "failed", reason: terminalsFailure(error) } }));
    }
  }, [client]);

  // Tabs are also created and closed from other windows and devices. The
  // listings already on screen are refreshed when this window regains focus;
  // `load` keeps a listing visible while it refreshes.
  const listed = useRef<string[]>([]);
  useEffect(() => {
    listed.current = Object.keys(terminals).filter((slot) => terminals[slot]?.status === "ready");
  }, [terminals]);
  useEffect(() => onEvent("window:focus-changed", ({ focused }) => {
    if (focused) for (const slot of listed.current) void load(slot);
  }), [load]);

  const open = useCallback((slot: string, refKey: string) => {
    if (!client || !platformHost) return;
    if (boundSlot.current !== slot) {
      // The shared terminal view reads its computer from the connection store.
      // This window never selects a computer app-wide; it only points its own
      // renderer's store at the computer whose tab is on screen.
      resetAttachManager();
      useConnection.setState({ status: "signed-in", platformHost, runtimeSlot: slot, api: client.forRuntime(slot) });
      boundSlot.current = slot;
    }
    selection.current += 1;
    setActive({ slot, refKey });
  }, [client, platformHost]);

  const create = useCallback(async (slot: string) => {
    if (!client || creating) return;
    const startedIn = session.current;
    const current = () => session.current === startedIn;
    const chosen = selection.current;
    setCreating(slot);
    setCreateFailed(null);
    try {
      const refKey = await createComputerTab(client.forRuntime(slot), "Terminal");
      if (!current()) return;
      await load(slot);
      // Signed out, or signed in as someone else, while the computer answered:
      // the new terminal belongs to a session this window no longer shows.
      if (!current()) return;
      // The user opened another terminal while this one was being created:
      // it is listed, but it does not take the pane away from their choice.
      if (selection.current !== chosen) return;
      open(slot, refKey);
    } catch (error: unknown) {
      console.warn("[terminal-window] tab create failed:", error instanceof Error ? error.name : "UnknownError");
      if (!current()) return;
      // The tabs already listed stay shown unless the computer now refuses the session.
      if (terminalsFailure(error) === "reconnect") {
        setTerminals((existing) => ({ ...existing, [slot]: { status: "failed", reason: "reconnect" } }));
      } else {
        setCreateFailed(slot);
      }
    } finally {
      // The session change already cleared this; do not clear the next session's.
      if (current()) setCreating(null);
    }
  }, [client, creating, load, open]);

  return { terminals, active, creating, createFailed, load, open, create };
}
