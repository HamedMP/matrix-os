import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/operator";
import { setAlternateTerminalSockets } from "../terminal/terminal-runtime";
import {
  LOCAL_TERMINAL_SESSION_PREFIX, type LocalTerminal, type LocalTerminalAgent, type LocalTerminalUnavailable,
} from "../../../../shared/local-terminals";
import { createLocalTerminalSocket } from "./local-terminal-socket";

export type LocalTerminalsState =
  | { status: "loading" }
  | { status: "ready"; terminals: LocalTerminal[] }
  | { [S in LocalTerminalUnavailable]: { status: S } }[LocalTerminalUnavailable];

/** The last action that did not take effect; the list it acted on stays shown. */
export type LocalTerminalsNotice = "create-failed" | "create-rate-limited" | "end-failed" | "rename-failed" | null;

const STATUS_POLL_MS = 3_000;

export const localSessionName = (id: string) => `${LOCAL_TERMINAL_SESSION_PREFIX}${id}`;

export function useLocalTerminals() {
  const [state, setState] = useState<LocalTerminalsState>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<LocalTerminalsNotice>(null);
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    try {
      const result = await invoke("local-terminal:list", {});
      if (current !== generation.current) return;
      setState(result.status === "ready"
        ? { status: "ready", terminals: result.terminals }
        : { status: result.status } as LocalTerminalsState);
    } catch (error: unknown) {
      if (current !== generation.current) return;
      console.warn("[local-terminal] list failed:", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "unavailable" });
    }
  }, []);

  useEffect(() => {
    setAlternateTerminalSockets({ prefix: LOCAL_TERMINAL_SESSION_PREFIX, create: createLocalTerminalSocket });
    void refresh();
    // Keep observing while hidden too: a completion must be noticed while
    // the person is away, not after refocusing the terminal.
    const timer = setInterval(() => { void refresh(); }, STATUS_POLL_MS);
    return () => {
      clearInterval(timer);
      generation.current += 1;
      setAlternateTerminalSockets(null);
    };
  }, [refresh]);

  /** Starts a login shell, or a known agent in one, and returns its id, or null when it could not start. */
  const create = useCallback(async (launch: { agent?: LocalTerminalAgent } = {}): Promise<string | null> => {
    if (creating) return null;
    setCreating(true);
    try {
      const result = await invoke("local-terminal:create", { cols: 100, rows: 30, ...(launch.agent ? { agent: launch.agent } : {}) });
      if (result.status === "ready") {
        setNotice(null);
        await refresh();
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
    // One failed start does not hide the terminals already listed: the next
    // listing decides whether local terminals are still reachable.
    setNotice("create-failed");
    await refresh();
    return null;
  }, [creating, refresh]);

  /** Ends a terminal. Resolves true only once the trusted core confirmed it. */
  const end = useCallback(async (id: string): Promise<boolean> => {
    let ended = false;
    try {
      ended = (await invoke("local-terminal:kill", { id })).ok;
    } catch (error: unknown) {
      console.warn("[local-terminal] end failed:", error instanceof Error ? error.name : "UnknownError");
    }
    setNotice(ended ? null : "end-failed");
    await refresh();
    return ended;
  }, [refresh]);

  /** Renames a terminal; the new name shows on every client of this core. */
  const rename = useCallback(async (id: string, name: string): Promise<boolean> => {
    let renamed = false;
    try {
      renamed = (await invoke("local-terminal:rename", { id, name })).ok;
    } catch (error: unknown) {
      console.warn("[local-terminal] rename failed:", error instanceof Error ? error.name : "UnknownError");
    }
    setNotice(renamed ? null : "rename-failed");
    await refresh();
    return renamed;
  }, [refresh]);

  return { state, creating, notice, refresh, create, end, rename };
}
