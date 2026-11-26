// Machines the Terminal window reaches over ssh (spec 2706 layer 7), as the
// trusted core's herdr-core knows them. The list is read on open, on focus,
// and every few seconds while a machine is still connecting.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, onEvent } from "../../lib/operator";
import type { LocalMachine, LocalMachineAddFailure, SshOptions, TailscalePeer } from "../../../../shared/local-terminals";

const SETTLING_REFRESH_MS = 5_000;
// A connected machine can drop, and an unreachable one come back, without anything here noticing.
const STEADY_REFRESH_MS = 20_000;

export type SshMachinesState = { status: "loading" | "unavailable" } | { status: "ready"; machines: LocalMachine[] };
export type AddMachineOutcome = { ok: true; machine: LocalMachine } | { ok: false; reason: LocalMachineAddFailure };
export type TailscalePeersState =
  | { status: "loading" }
  | { status: "ready"; peers: TailscalePeer[] }
  | { status: "missing" | "stopped" | "logged-out" | "unavailable" };

export function useSshMachines() {
  const [state, setState] = useState<SshMachinesState>({ status: "loading" });
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await invoke("local-terminal:machines", {});
      if (current !== generation.current) return;
      // A failed look keeps the last list (and the timer that looks again) instead of hiding the machines.
      setState((previous) => (result.status === "ready" ? { status: "ready", machines: result.machines }
        : previous.status === "ready" ? previous : { status: "unavailable" }));
    } catch (error: unknown) {
      if (current !== generation.current) return;
      console.warn("[terminal-window] machines unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState((previous) => (previous.status === "ready" ? previous : { status: "unavailable" }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stop = onEvent("window:focus-changed", ({ focused }) => { if (focused) void refresh(); });
    return () => { generation.current += 1; stop(); };
  }, [refresh]);

  // A machine still dialling settles soon; others change rarely. Only while the window is visible.
  const settling = state.status === "ready" && state.machines.some((machine) => machine.state === "connecting");
  const any = state.status === "ready" && state.machines.length > 0;
  useEffect(() => {
    if (!any) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, settling ? SETTLING_REFRESH_MS : STEADY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [any, refresh, settling]);

  const add = useCallback(async (target: string, name?: string, ssh?: SshOptions): Promise<AddMachineOutcome> => {
    let outcome: AddMachineOutcome = { ok: false, reason: "unavailable" };
    try {
      outcome = await invoke("local-terminal:machine-add", { target, ...(name ? { name } : {}), ...(ssh ? { ssh } : {}) });
    } catch (error: unknown) {
      console.warn("[terminal-window] add machine failed:", error instanceof Error ? error.name : "UnknownError");
    }
    await refresh();
    return outcome;
  }, [refresh]);

  // Machines whose core is being installed or updated, and the last that failed (spec 2706 layer 8).
  const [coreBusy, setCoreBusy] = useState<string[]>([]);
  const [coreFailed, setCoreFailed] = useState<string[]>([]);
  const [coreChanged, setCoreChanged] = useState<string[]>([]);
  // Machines whose update transport cannot be pinned, from their last attempt.
  const [coreUnsupported, setCoreUnsupported] = useState<string[]>([]);

  const remove = useCallback(async (name: string): Promise<boolean> => {
    let removed = false;
    try {
      removed = (await invoke("local-terminal:machine-remove", { name })).ok;
      // A failure belongs to the machine it happened on, not to the next one that takes its name.
      if (removed) {
        // Every note about its core belongs to that machine, not to the next one that takes its name.
        const forget = (current: string[]) => current.filter((entry) => entry !== name);
        setCoreFailed(forget);
        setCoreChanged(forget);
        setCoreUnsupported(forget);
      }
    } catch (error: unknown) {
      console.warn("[terminal-window] remove machine failed:", error instanceof Error ? error.name : "UnknownError");
    }
    await refresh();
    return removed;
  }, [refresh]);

  const connect = useCallback(async (name: string) => {
    try {
      await invoke("local-terminal:machine-connect", { name });
    } catch (error: unknown) {
      console.warn("[terminal-window] connect machine failed:", error instanceof Error ? error.name : "UnknownError");
    }
    await refresh();
  }, [refresh]);

  /** Open in terminal for an added machine, the way it was added; its id, or null. */
  const machineLogin = useCallback(async (name: string): Promise<string | null> => {
    try {
      const result = await invoke("local-terminal:machine-login", { name, cols: 100, rows: 30 });
      return result.status === "ready" ? result.id : null;
    } catch (error: unknown) {
      console.warn("[terminal-window] machine login terminal failed:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, []);

  /** A terminal on this device running `ssh <target>`; its id, or null. */
  const sshLogin = useCallback(async (target: string, ssh?: SshOptions): Promise<string | null> => {
    try {
      const result = await invoke("local-terminal:ssh-login", { target, ...(ssh ? { ssh } : {}), cols: 100, rows: 30 });
      return result.status === "ready" ? result.id : null;
    } catch (error: unknown) {
      console.warn("[terminal-window] ssh login terminal failed:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, []);

  /** This Mac's tailnet peers, read when Add machine opens. */
  const tailscalePeers = useCallback(async (): Promise<TailscalePeersState> => {
    try {
      return await invoke("local-terminal:tailscale-peers", {});
    } catch (error: unknown) {
      console.warn("[terminal-window] tailscale peers unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { status: "unavailable" };
    }
  }, []);

  const coreJob = useCallback(async (name: string, job: () => Promise<{ ok: boolean; reason?: string }>): Promise<boolean> => {
    setCoreBusy((current) => [...current.filter((entry) => entry !== name), name]);
    let ok = false;
    let changed = false;
    let unsupported = false;
    try {
      const result = await job();
      ok = result.ok;
      changed = result.reason === "changed";
      unsupported = result.reason === "unsupported";
    } catch (error: unknown) {
      console.warn("[terminal-window] machine core failed:", error instanceof Error ? error.name : "UnknownError");
    }
    setCoreBusy((current) => current.filter((entry) => entry !== name));
    // Each machine keeps its own failure until its own job succeeds.
    setCoreFailed((current) => (ok ? current.filter((entry) => entry !== name) : [...current.filter((entry) => entry !== name), name]));
    // The name now belongs to another machine than the one picked: nothing ran, and the list shows the new one.
    setCoreChanged((current) => (changed ? [...current.filter((entry) => entry !== name), name] : current.filter((entry) => entry !== name)));
    setCoreUnsupported((current) => (unsupported ? [...current.filter((entry) => entry !== name), name] : current.filter((entry) => entry !== name)));
    await refresh();
    return ok;
  }, [refresh]);
  /** Adds a machine with no core (or an old one), installing the app's core there. */
  const install = useCallback((target: string, name: string, ssh?: SshOptions) => coreJob(name,
    () => invoke("local-terminal:machine-install", { target, name, ...(ssh ? { ssh } : {}) })), [coreJob]);
  /** Brings a machine's core to the app's version; its terminals keep running. */
  /** Bound to the machine as listed (name and target), so a name reused meanwhile is refused. */
  const update = useCallback((machine: LocalMachine) => coreJob(machine.name, () => invoke("local-terminal:machine-update", {
    name: machine.name, target: machine.target,
    ...(machine.coreId ? { coreId: machine.coreId } : {}), ...(machine.ssh ? { ssh: machine.ssh } : {}),
  })), [coreJob]);

  return { state, refresh, add, remove, connect, sshLogin, machineLogin, tailscalePeers, install, update, coreBusy, coreFailed, coreChanged, coreUnsupported };
}
