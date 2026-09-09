import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "./operator";
import type { ApiClient } from "./api";
import { loadRepairPlan, repairVersions, type RepairPlan } from "./compatibility-repair";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../stores/runtime-generation";

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new Error("Update cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2_000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function useCompatibilityRepair(api: ApiClient | null, runtimeSlot: string, open: boolean) {
  const [plan, setPlan] = useState<RepairPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState(false);
  const [complete, setComplete] = useState(false);
  const flight = useRef(false);
  const active = useRef<AbortController | null>(null);
  const bound = useMemo(() => ({ api: api?.forRuntime(runtimeSlot) ?? null, generation: captureRuntimeGeneration() }), [api, runtimeSlot]);
  useEffect(() => {
    flight.current = false;
    setPlan(null);
    setBusy(false);
    return () => { active.current?.abort(); };
  }, [bound]);
  const readLocal = useCallback(async () => {
    const [version, snapshot] = await Promise.allSettled([invoke("app:get-version", {}), invoke("update:check", {})]);
    return { version: version.status === "fulfilled" ? version.value.version : undefined,
      snapshot: snapshot.status === "fulfilled" ? snapshot.value : undefined };
  }, []);
  const perform = useCallback(async (install: boolean) => {
    if (!bound.api || flight.current) return;
    flight.current = true;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const scope = { api: bound.api, signal: controller.signal, isCurrent: () => isCurrentRuntimeGeneration(bound.generation) };
    const current = () => active.current === controller && !scope.signal.aborted && scope.isCurrent();
    setLoading(true);
    setBusy(install);
    setError(false);
    setComplete(false);
    setProgress(install ? "Confirming the latest versions…" : "");
    try {
      const latest = await loadRepairPlan({ ...scope, readLocal });
      if (!current()) return;
      setPlan(latest);
      setLoading(false);
      if (install && latest.targets.length) {
        await repairVersions(latest, { ...scope,
          checkLocal: () => invoke("update:check", {}),
          getLocal: () => invoke("update:get-state", {}),
          installLocal: () => invoke("update:install", {}),
          progress: (message) => { if (current()) setProgress(message); },
          pause: () => pause(scope.signal),
        });
        if (current() && !latest.targets.includes("local")) {
          const refreshed = await loadRepairPlan({ ...scope, readLocal });
          if (current()) setPlan(refreshed);
        }
        if (current()) setComplete(true);
      }
    } catch (err: unknown) {
      if (current()) {
        console.warn("[compatibility-repair] update flow failed:", err instanceof Error ? err.name : "UnknownError");
        setError(true);
        setProgress("");
      }
    } finally {
      if (active.current === controller) flight.current = false;
      if (current()) { setLoading(false); setBusy(false); }
    }
  }, [bound, readLocal]);
  useEffect(() => { if (open) void perform(false); }, [open, perform]);
  return { plan, loading, busy, progress, error, complete,
    check: () => perform(false), update: () => perform(true) };
}
