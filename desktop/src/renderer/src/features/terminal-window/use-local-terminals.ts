import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/operator";
import { setAlternateTerminalSockets } from "../terminal/terminal-runtime";
import {
  LOCAL_TERMINAL_SESSION_PREFIX, type LocalTerminal, type LocalTerminalAgent, type LocalTerminalFact, type LocalTerminalUnavailable,
} from "../../../../shared/local-terminals";
import { createLocalTerminalSocket } from "./local-terminal-socket";
import { useLocalTerminalFacts } from "./use-terminal-status";

export type LocalTerminalsState =
  | { status: "loading" }
  | { status: "ready"; terminals: LocalTerminal[]; facts: LocalTerminalFact[] }
  | { [S in LocalTerminalUnavailable]: { status: S } }[LocalTerminalUnavailable];

/** The last action that did not take effect; the list it acted on stays shown. */
export type LocalTerminalsNotice = "create-failed" | "create-rate-limited" | "end-failed" | "rename-failed" | null;

export const localSessionName = (id: string) => `${LOCAL_TERMINAL_SESSION_PREFIX}${id}`;

/**
 * This device's terminals. The list follows herdr-core's events through the
 * trusted core (spec 2706), so a change, a completion included, shows as it
 * happens, whether or not the window has focus; nothing is polled.
 */
export function useLocalTerminals() {
  const { state: facts, retry } = useLocalTerminalFacts();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<LocalTerminalsNotice>(null);

  const state = useMemo<LocalTerminalsState>(() => {
    if (facts.status !== "ready") return facts;
    // The machine's own live terminals; ones on added machines and finished ones are sidebar rows only.
    const terminals = facts.terminals.filter((fact) => !fact.finished && !fact.id.includes("/"))
      .map((fact) => ({ id: fact.id, title: fact.title, status: fact.status, ...(fact.statusMessage ? { statusMessage: fact.statusMessage } : {}) }));
    return { status: "ready", terminals, facts: facts.terminals };
  }, [facts]);

  useEffect(() => {
    setAlternateTerminalSockets({ prefix: LOCAL_TERMINAL_SESSION_PREFIX, create: createLocalTerminalSocket });
    return () => { setAlternateTerminalSockets(null); };
  }, []);

  /** Starts a login shell, or a known agent in one, and returns its id, or null when it could not start. */
  const create = useCallback(async (launch: { agent?: LocalTerminalAgent } = {}): Promise<string | null> => {
    if (creating) return null;
    setCreating(true);
    try {
      const result = await invoke("local-terminal:create", { cols: 100, rows: 30, ...(launch.agent ? { agent: launch.agent } : {}) });
      if (result.status === "ready") {
        setNotice(null);
        return result.id;
      }
      if (result.status === "rate-limited") {
        setNotice("create-rate-limited");
        return null;
      }
    } catch (error: unknown) {
      console.warn("[local-terminal] create failed:", error instanceof Error ? error.name : "UnknownError");
    } finally {
      setCreating(false);
    }
    setNotice("create-failed");
    return null;
  }, [creating]);

  /** Ends a terminal. Resolves true only once the trusted core confirmed it. */
  const end = useCallback(async (id: string): Promise<boolean> => {
    let ended = false;
    try {
      ended = (await invoke("local-terminal:kill", { id })).ok;
    } catch (error: unknown) {
      console.warn("[local-terminal] end failed:", error instanceof Error ? error.name : "UnknownError");
    }
    setNotice(ended ? null : "end-failed");
    return ended;
  }, []);

  /** Removes a finished terminal from the list. */
  const remove = useCallback(async (id: string): Promise<boolean> => {
    let removed = false;
    try {
      removed = (await invoke("local-terminal:remove", { id })).ok;
    } catch (error: unknown) {
      console.warn("[local-terminal] remove failed:", error instanceof Error ? error.name : "UnknownError");
    }
    setNotice(removed ? null : "end-failed");
    return removed;
  }, []);

  /** Renames a terminal; the new name shows on every client of this core. */
  const rename = useCallback(async (id: string, name: string): Promise<boolean> => {
    let renamed = false;
    try {
      renamed = (await invoke("local-terminal:rename", { id, name })).ok;
    } catch (error: unknown) {
      console.warn("[local-terminal] rename failed:", error instanceof Error ? error.name : "UnknownError");
    }
    setNotice(renamed ? null : "rename-failed");
    return renamed;
  }, []);

  return { state, creating, notice, retry, create, end, remove, rename };
}
