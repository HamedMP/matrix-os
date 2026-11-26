import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeDesktopTerminal, loadDesktopMachines, loadDesktopTerminals, DesktopLinkRequestError, NO_DESKTOPS, removeDesktop, startDesktopTerminal,
  type DesktopAgent, type DesktopLinkMachine, type DesktopLinkRequest, type DesktopMachines, type DesktopTerminals,
} from "./desktop-link-client.js";

const DEFAULT_INTERVAL_MS = 5_000;

export const DESKTOP_ACTION_FAILED: Record<DesktopLinkRequestError["code"], string> = {
  offline: "That desktop is out of reach right now.",
  denied: "That desktop refused it.",
  busy: "Too many terminals were started just now. Try again in a minute.",
  failed: "That didn't work. Try again.",
};

function message(error: unknown): string {
  return error instanceof DesktopLinkRequestError ? DESKTOP_ACTION_FAILED[error.code] : DESKTOP_ACTION_FAILED.failed;
}

/**
 * The owner's linked desktops and each online desktop's terminals, refreshed every few
 * seconds while mounted. A failed load shows no desktops rather than an error.
 */
export function useDesktopMachines(options: { request: DesktopLinkRequest | null; intervalMs?: number }) {
  const { request } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [desktops, setMacs] = useState<DesktopMachines>(NO_DESKTOPS);
  // Keyed by device id; holds only the desktops in the latest listing (at most five).
  const [terminals, setTerminals] = useState<Record<string, DesktopTerminals>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(0);

  const refresh = useCallback(async () => {
    if (!request) return;
    const started = ++generation.current;
    pending.current += 1;
    try {
      const next = await loadDesktopMachines(request);
      const online = next.machines.filter((machine) => machine.state === "online");
      const listed = await Promise.all(online.map(async (machine) => {
        try { return [machine.deviceId, await loadDesktopTerminals(request, machine.deviceId)] as const; }
        catch (loadError: unknown) {
          if (!(loadError instanceof DesktopLinkRequestError)) throw loadError;
          return null;
        }
      }));
      if (started !== generation.current) return;
      setMacs(next);
      setTerminals(Object.fromEntries(listed.filter((entry): entry is readonly [string, DesktopTerminals] => entry !== null)));
    } catch (loadError: unknown) {
      console.warn("[desktop-link] load failed", loadError instanceof Error ? loadError.name : "unknown_error");
      if (started === generation.current) { setMacs(NO_DESKTOPS); setTerminals({}); }
    } finally {
      pending.current -= 1;
    }
  }, [request]);

  useEffect(() => {
    if (!request) return undefined;
    void refresh();
    const timer = setInterval(() => { if (pending.current === 0) void refresh(); }, intervalMs);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [request, refresh, intervalMs]);

  const run = useCallback(async <T,>(key: string, action: (send: DesktopLinkRequest) => Promise<T>): Promise<T | null> => {
    if (!request) return null;
    setBusy((keys) => (keys.includes(key) ? keys : [...keys, key]));
    setError(null);
    try {
      const result = await action(request);
      await refresh();
      return result;
    } catch (actionError: unknown) {
      console.warn("[desktop-link] action failed", actionError instanceof Error ? actionError.name : "unknown_error");
      setError(message(actionError));
      return null;
    } finally {
      setBusy((keys) => keys.filter((candidate) => candidate !== key));
    }
  }, [request, refresh]);

  const start = useCallback((deviceId: string, agent?: DesktopAgent) =>
    run(`start:${deviceId}`, (send) => startDesktopTerminal(send, deviceId, agent)), [run]);
  const close = useCallback(async (deviceId: string, id: string) =>
    (await run(`close:${deviceId}:${id}`, (send) => closeDesktopTerminal(send, deviceId, id).then(() => true))) === true, [run]);
  const remove = useCallback(async (machine: DesktopLinkMachine) => {
    const machineId = desktops.machineId;
    if (!machineId) return false;
    return (await run(`remove:${machine.deviceId}`, (send) => removeDesktop(send, machineId, machine).then(() => true))) === true;
  }, [run, desktops.machineId]);

  return { desktops, terminals, busy, error, refresh, start, close, remove };
}

export type DesktopMachinesState = ReturnType<typeof useDesktopMachines>;
