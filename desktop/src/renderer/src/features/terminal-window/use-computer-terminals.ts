import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient, type ApiClient } from "../../lib/api";
import { resetAttachManager } from "../terminal/terminal-runtime";
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
  const generations = useRef<Record<string, number>>({});
  const boundSlot = useRef<string | null>(null);

  const client = useMemo<ApiClient | null>(
    () => (platformHost ? createApiClient({ baseUrl: platformHost, getRuntimeSlot: () => "primary" }) : null),
    [platformHost],
  );

  useEffect(() => {
    generations.current = {};
    boundSlot.current = null;
    setTerminals({});
    setActive(null);
    setCreating(null);
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
    setActive({ slot, refKey });
  }, [client, platformHost]);

  const create = useCallback(async (slot: string) => {
    if (!client || creating) return;
    setCreating(slot);
    try {
      const refKey = await createComputerTab(client.forRuntime(slot), "Terminal");
      await load(slot);
      open(slot, refKey);
    } catch (error: unknown) {
      console.warn("[terminal-window] tab create failed:", error instanceof Error ? error.name : "UnknownError");
      setTerminals((current) => ({ ...current, [slot]: { status: "failed", reason: terminalsFailure(error) } }));
    } finally {
      setCreating(null);
    }
  }, [client, creating, load, open]);

  return { terminals, active, creating, load, open, create };
}
