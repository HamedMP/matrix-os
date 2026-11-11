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
  | { status: "ready"; computers: MatrixComputer[]; platformHost: string; sessionKey: string };

const AVAILABILITY_REFRESH_MS = 30_000;

export function useTerminalMachines(): { state: TerminalMachinesState; retry: () => void } {
  const [state, setState] = useState<TerminalMachinesState>({ status: "loading" });
  const generation = useRef(0);

  // `quiet` refreshes what is already shown without a loading flash, and keeps
  // it if the refresh fails: a computer that was starting may be ready now.
  const load = useCallback(async (quiet = false) => {
    const current = ++generation.current;
    if (!quiet) setState({ status: "loading" });
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
      setState({
        status: "ready",
        computers: parsed.data.items,
        platformHost: status.platformHost,
        // A replaced credential is a new session even for the same account.
        sessionKey: `${status.platformHost}|${status.handle}|${status.authGeneration}`,
      });
    } catch (error: unknown) {
      if (current !== generation.current) return;
      console.warn("[terminal-window] inventory unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (!quiet) setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = onEvent("auth:changed", () => { void load(); });
    // Availability changes without any action here (a computer finishes
    // starting, or stops), so the list is refreshed when the window regains
    // focus and periodically while it is visible.
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const unsubscribeFocus = onEvent("window:focus-changed", ({ focused }) => { if (focused) refresh(); });
    const timer = setInterval(refresh, AVAILABILITY_REFRESH_MS);
    return () => {
      generation.current += 1;
      clearInterval(timer);
      unsubscribe();
      unsubscribeFocus();
    };
  }, [load]);

  return { state, retry: () => { void load(); } };
}
