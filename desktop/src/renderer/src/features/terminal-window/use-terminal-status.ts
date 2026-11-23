// Live status for the Terminal window's sidebar (spec 2706 layer 4): local
// terminals from herdr-core's events through the trusted core, and one
// `/ws/terminal/events` subscription per available Matrix computer.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatrixComputer } from "@matrix-os/contracts";
import {
  createTerminalEventsClient,
  EMPTY_TERMINAL_EVENTS_STATE,
  type TerminalEventsSocket,
  type TerminalEventsState,
} from "@matrix-os/ui/terminal-agents";
import {
  computerSidebarRows,
  localSidebarRows,
  type TerminalSidebarMachine,
  type TerminalSidebarRow,
} from "@matrix-os/ui/terminal-status-sidebar";
import { invoke, onEvent } from "../../lib/operator";
import { buildTerminalEventsWsUrl } from "../../stores/terminal-agent-events";
import type { LocalTerminalFact, LocalTerminalUnavailable } from "../../../../shared/local-terminals";

const LOCAL_MACHINE_ID = "local";
/** This device, named as Herdr names it on a Mac. */
export function localMachine(isMac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac")): TerminalSidebarMachine {
  return { id: LOCAL_MACHINE_ID, name: isMac ? "This Mac" : "This Computer", remote: false };
}
const COMPUTER_PREFIX = "computer:";

export const computerMachineId = (slot: string) => `${COMPUTER_PREFIX}${slot}`;

/** A computer by its own name (its handle), so rows can tell computers apart. */
export function computerMachine(computer: Pick<MatrixComputer, "runtimeSlot" | "handle">): TerminalSidebarMachine {
  return { id: computerMachineId(computer.runtimeSlot), name: computer.handle, remote: true };
}

export type LocalTerminalFactsState =
  | { status: "loading" }
  | { status: "ready"; terminals: LocalTerminalFact[] }
  | { status: LocalTerminalUnavailable };

/** Local status facts: one `watch`, then pushed changes; no polling. `retry` watches again after a failure. */
export function useLocalTerminalFacts(): { state: LocalTerminalFactsState; retry(): void } {
  const [state, setState] = useState<LocalTerminalFactsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    // A pushed change can arrive before `watch` answers; it is the newer one.
    let pushed = false;
    const stop = onEvent("local-terminal:facts", ({ terminals }) => {
      if (!current) return;
      pushed = true;
      setState({ status: "ready", terminals });
    });
    invoke("local-terminal:watch", {}).then((result) => {
      if (!current) return;
      if (result.status !== "ready") setState({ status: result.status });
      else if (!pushed) setState({ status: "ready", terminals: result.terminals });
    }, (error: unknown) => {
      if (!current) return;
      console.warn("[terminal-window] local status unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "unavailable" });
    });
    return () => { current = false; stop(); };
  }, [attempt]);
  const retry = useCallback(() => { setState({ status: "loading" }); setAttempt((value) => value + 1); }, []);
  return { state, retry };
}

/**
 * One events stream per available computer, keyed by runtime slot. Streams
 * close when a computer leaves the list or becomes unavailable, and all of
 * them when the signed-in session changes or the window closes.
 */
export function useComputerTerminalEvents(options: {
  platformHost: string | null;
  sessionKey: string;
  slots: readonly string[];
  createSocket?: (url: string) => TerminalEventsSocket;
}) {
  const { platformHost, sessionKey, createSocket } = options;
  const [states, setStates] = useState<Record<string, TerminalEventsState>>({});
  // At most one client per listed computer (the platform lists at most 20).
  const clients = useRef(new Map<string, ReturnType<typeof createTerminalEventsClient>>());
  const slotsKey = [...options.slots].sort().join(",");

  useEffect(() => {
    const open = clients.current;
    for (const client of open.values()) client.stop();
    open.clear();
    setStates({});
    return () => {
      for (const client of open.values()) client.stop();
      open.clear();
    };
  }, [platformHost, sessionKey]);

  useEffect(() => {
    const open = clients.current;
    const wanted = new Set(slotsKey ? slotsKey.split(",") : []);
    for (const [slot, client] of open) {
      if (wanted.has(slot)) continue;
      client.stop();
      open.delete(slot);
      setStates((current) => {
        const { [slot]: _gone, ...rest } = current;
        void _gone;
        return rest;
      });
    }
    if (!platformHost) return;
    for (const slot of wanted) {
      if (open.has(slot)) continue;
      const url = buildTerminalEventsWsUrl(platformHost, slot);
      const client = createTerminalEventsClient({
        url: () => url,
        // The trusted core adds this computer's bearer to the upgrade; the URL carries no credential.
        createSocket: createSocket ?? ((target) => new WebSocket(target) as unknown as TerminalEventsSocket),
        onState: (state) => {
          if (open.get(slot) !== client) return;
          setStates((current) => ({ ...current, [slot]: state }));
        },
      });
      open.set(slot, client);
      client.start();
    }
  }, [createSocket, platformHost, sessionKey, slotsKey]);

  const markSeen = useCallback((slot: string, ref: { workspaceId: string; tabId: string }) => (
    clients.current.get(slot)?.markSeen(ref) ?? false
  ), []);

  return { states, markSeen };
}

/** Every terminal the sidebar shows: this Mac first, then each computer in inventory order. */
export function terminalStatusRows(
  local: LocalTerminalFactsState,
  computers: ReadonlyArray<Pick<MatrixComputer, "runtimeSlot" | "handle">>,
  states: Readonly<Record<string, TerminalEventsState>>,
  here: TerminalSidebarMachine = localMachine(),
): TerminalSidebarRow[] {
  const rows = local.status === "ready" ? localSidebarRows(local.terminals, here) : [];
  for (const computer of computers) {
    rows.push(...computerSidebarRows(states[computer.runtimeSlot] ?? EMPTY_TERMINAL_EVENTS_STATE, computerMachine(computer)));
  }
  return rows;
}

/** Where a sidebar row's terminal lives, from its key. */
export type TerminalRowTarget =
  | { kind: "local"; id: string }
  | { kind: "computer"; slot: string; ref: { workspaceId: string; tabId: string } };

const REF_KEY = /^(tws_[0-9a-f]{32}):(tt_[0-9a-f]{32})$/;

export function terminalRowTarget(key: string): TerminalRowTarget | null {
  const bar = key.indexOf("|");
  if (bar < 0) return null;
  const machine = key.slice(0, bar);
  const terminal = key.slice(bar + 1);
  if (machine === LOCAL_MACHINE_ID) return { kind: "local", id: terminal };
  if (!machine.startsWith(COMPUTER_PREFIX)) return null;
  const ref = REF_KEY.exec(terminal);
  if (!ref) return null;
  return { kind: "computer", slot: machine.slice(COMPUTER_PREFIX.length), ref: { workspaceId: ref[1]!, tabId: ref[2]! } };
}

/** The sidebar's rows and marking a terminal seen. `local` is this device's facts (`useLocalTerminalFacts`). */
export function useTerminalStatus(options: {
  local: LocalTerminalFactsState;
  platformHost: string | null;
  sessionKey: string;
  computers: readonly MatrixComputer[];
  createSocket?: (url: string) => TerminalEventsSocket;
}) {
  const { local } = options;
  const available = useMemo(() => options.computers.filter((computer) => computer.availability === "available"), [options.computers]);
  const slots = useMemo(() => available.map((computer) => computer.runtimeSlot), [available]);
  const computers = useComputerTerminalEvents({
    platformHost: options.platformHost, sessionKey: options.sessionKey, slots, createSocket: options.createSocket,
  });
  const rows = useMemo(() => terminalStatusRows(local, available, computers.states), [local, available, computers.states]);
  const { markSeen: markComputerSeen } = computers;

  /** The person opened this terminal: shared with their other windows and devices. */
  const markSeen = useCallback((key: string) => {
    const target = terminalRowTarget(key);
    if (!target) return;
    if (target.kind === "computer") {
      markComputerSeen(target.slot, target.ref);
      return;
    }
    void invoke("local-terminal:seen", { id: target.id }).catch((error: unknown) => {
      console.warn("[terminal-window] mark seen failed:", error instanceof Error ? error.name : "UnknownError");
    });
  }, [markComputerSeen]);

  return { rows, states: computers.states, markSeen };
}
