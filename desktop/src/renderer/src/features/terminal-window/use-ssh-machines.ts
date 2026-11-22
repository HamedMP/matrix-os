// Machines the Terminal window reaches over ssh (spec 2706 layer 7), as the
// trusted core's herdr-core knows them. The list is read on open, on focus,
// and every few seconds while a machine is still connecting.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, onEvent } from "../../lib/operator";
import type { LocalMachine, LocalMachineAddFailure } from "../../../../shared/local-terminals";

const SETTLING_REFRESH_MS = 5_000;
// A connected machine can drop, and an unreachable one come back, without anything here noticing.
const STEADY_REFRESH_MS = 20_000;

export type SshMachinesState = { status: "loading" | "unavailable" } | { status: "ready"; machines: LocalMachine[] };
export type AddMachineOutcome = { ok: true; machine: LocalMachine } | { ok: false; reason: LocalMachineAddFailure };

export function useSshMachines() {
  const [state, setState] = useState<SshMachinesState>({ status: "loading" });
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await invoke("local-terminal:machines", {});
      if (current !== generation.current) return;
      setState(result.status === "ready" ? { status: "ready", machines: result.machines } : { status: "unavailable" });
    } catch (error: unknown) {
      if (current !== generation.current) return;
      console.warn("[terminal-window] machines unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "unavailable" });
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

  const add = useCallback(async (target: string, name?: string): Promise<AddMachineOutcome> => {
    let outcome: AddMachineOutcome = { ok: false, reason: "unavailable" };
    try {
      outcome = await invoke("local-terminal:machine-add", { target, ...(name ? { name } : {}) });
    } catch (error: unknown) {
      console.warn("[terminal-window] add machine failed:", error instanceof Error ? error.name : "UnknownError");
    }
    await refresh();
    return outcome;
  }, [refresh]);

  const remove = useCallback(async (name: string): Promise<boolean> => {
    let removed = false;
    try {
      removed = (await invoke("local-terminal:machine-remove", { name })).ok;
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

  /** A terminal on this device running `ssh <target>`; its id, or null. */
  const sshLogin = useCallback(async (target: string): Promise<string | null> => {
    try {
      const result = await invoke("local-terminal:ssh-login", { target, cols: 100, rows: 30 });
      return result.status === "ready" ? result.id : null;
    } catch (error: unknown) {
      console.warn("[terminal-window] ssh login terminal failed:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, []);

  return { state, refresh, add, remove, connect, sshLogin };
}
