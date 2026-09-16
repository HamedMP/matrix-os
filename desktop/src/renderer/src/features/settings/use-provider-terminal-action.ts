import { useEffect, useRef, useState } from "react";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { openProviderSetupTerminal, type ProviderSetupCommand } from "../coding-agents/provider-setup-terminal";

/** Refresh CLI-owned credentials when the owner returns from the auth terminal. */
export function useProviderSettingsReturnSequence(): number {
  const [sequence, setSequence] = useState(0);
  useEffect(() => useTabs.subscribe((state, previous) => {
    if (state.activeTabId === previous.activeTabId) return;
    if (state.tabs.find((tab) => tab.id === state.activeTabId)?.kind === "settings") {
      setSequence((value) => value + 1);
    }
  }), []);
  return sequence;
}

export function useProviderTerminalAction(logPrefix: string) {
  const api = useConnection((state) => state.api);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const open = async (setup: ProviderSetupCommand) => {
    if (inFlight.current) return;
    setError(null);
    if (!api) {
      setError("Connect to your Matrix computer to manage coding agent providers.");
      return;
    }
    const generation = captureRuntimeGeneration();
    inFlight.current = true;
    setPending(true);
    try {
      const opened = await openProviderSetupTerminal(api, setup, useTabs.getState().openTab, logPrefix);
      if (mounted.current && isCurrentRuntimeGeneration(generation) && !opened) {
        setError("Could not open setup terminal. Try again from Terminal.");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return { open, pending, error };
}
