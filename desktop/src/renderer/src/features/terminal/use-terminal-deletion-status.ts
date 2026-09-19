import { useEffect, useState } from "react";

/** Retain pending row feedback through acknowledgement and list reconciliation. */
export function useTerminalDeletionStatus(sessions: readonly { name: string }[], runtimeSlot: string | null) {
  const [deletingNames, setDeletingNames] = useState<string[]>([]);
  useEffect(() => {
    setDeletingNames((current) => {
      const retained = current.filter((name) => sessions.some((session) => session.name === name));
      return retained.length === current.length ? current : retained;
    });
  }, [sessions]);
  useEffect(() => { setDeletingNames([]); }, [runtimeSlot]);
  return {
    deletingNames,
    beginDeletion: (name: string) => setDeletingNames((current) => (
      current.includes(name) || !sessions.some((session) => session.name === name)
        ? current : [...current, name]
    )),
    failDeletion: (name: string) => setDeletingNames((current) => current.filter((entry) => entry !== name)),
  };
}
