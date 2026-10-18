"use client";
import { useCallback, useEffect, useState } from "react";
import { SharedBackgroundTask } from "./SharedBackgroundTask";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { ShellHome } from "@/components/ShellHome";
import { SHARED_WORKSPACE_PREFIX, parseSharedRuntimeState, sharedRuntimePresentation, type SharedRuntimeState } from "@/lib/shared-workspace";

export function SharedWorkspaceDesktop() {
  const [state, setState] = useState<SharedRuntimeState>("starting");
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = (path: string, init: RequestInit = {}) => fetch(`${SHARED_WORKSPACE_PREFIX}${path}`, {
      ...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    async function refresh() {
      try {
        const response = await request("/api/workspace/runtime");
        if (!response.ok) { setState(response.status === 403 ? "disabled" : "failed"); return; }
        const payload = await response.json();
        if (!controller.signal.aborted) setState(parseSharedRuntimeState(payload.state));
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          console.warn("[workspace] Runtime status unavailable", error instanceof Error ? error.name : "UnknownError");
          setState("failed");
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 3000);
      }
    }
    async function wake() {
      try {
        // Effect starts after the existing desktop is rendered. The queue response
        // acknowledges scheduling; status polling owns actual readiness.
        const response = await request("/api/workspace/actions", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "wake" }),
        });
        if (!response.ok && response.status === 403 && !controller.signal.aborted) setState("disabled");
        // An accepted or ambiguous wake is not readiness. The independent
        // status loop remains authoritative and also recovers after timeouts.
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          console.warn("[workspace] Compute start unavailable", error instanceof Error ? error.name : "UnknownError");
        }
      }
    }
    // Exactly one polling loop starts even if wake never settles, so a cold
    // request timeout cannot leave an already-running workspace stale forever.
    void refresh();
    void wake();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [attempt]);
  const presentation = sharedRuntimePresentation(state);
  return <>
    <ShellHome />
    <aside className="fixed bottom-20 left-1/2 flex w-[36rem] max-w-[90vw] -translate-x-1/2 flex-col gap-3 rounded-xl border border-border bg-card px-4 py-2 text-sm text-card-foreground shadow-sm" aria-label="Workspace compute" style={{ zIndex: SHELL_Z_INDEX.sharedWorkspaceControls }}>
      <div className="flex items-center gap-3"><span role="status" aria-live="polite">{presentation.message}</span>
      {presentation.retry ? <button type="button" className="shrink-0 underline underline-offset-4" onClick={retry}>Retry compute</button> : null}</div>
      <SharedBackgroundTask />
    </aside>
  </>;
}
