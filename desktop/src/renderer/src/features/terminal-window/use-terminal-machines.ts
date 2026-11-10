// Inventory for the Terminal window. It deliberately does not reuse the main
// window's connection store: that store drives selection, embeds and caches
// the Terminal window must never touch.
import { useCallback, useEffect, useRef, useState } from "react";
import { MatrixComputerListSchema, type MatrixComputer } from "@matrix-os/contracts";
import { invoke, onEvent } from "../../lib/operator";

export type TerminalMachinesState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error" }
  | { status: "ready"; computers: MatrixComputer[] };

export function useTerminalMachines(): { state: TerminalMachinesState; retry: () => void } {
  const [state, setState] = useState<TerminalMachinesState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setState({ status: "loading" });
    try {
      const status = await invoke("auth:status", {});
      if (current !== generation.current) return;
      if (!status.signedIn) {
        setState({ status: "signed-out" });
        return;
      }
      const parsed = MatrixComputerListSchema.safeParse(await invoke("runtime:list-computers", {}));
      if (current !== generation.current) return;
      if (!parsed.success) throw new Error("invalid computer list");
      setState({ status: "ready", computers: parsed.data.items });
    } catch (error: unknown) {
      if (current !== generation.current) return;
      console.warn("[terminal-window] inventory unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = onEvent("auth:changed", () => { void load(); });
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [load]);

  return { state, retry: () => { void load(); } };
}
