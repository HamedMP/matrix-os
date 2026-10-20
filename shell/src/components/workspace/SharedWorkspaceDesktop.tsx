"use client";
import { useCallback, useEffect, useState } from "react";
import { SharedBackgroundTask } from "./SharedBackgroundTask";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { startSharedWorkspaceRuntime } from "@/lib/shared-workspace-runtime";
import { ShellHome } from "@/components/ShellHome";
import { sharedRuntimePresentation, type SharedRuntimeState } from "@/lib/shared-workspace";

export function SharedWorkspaceDesktop() {
  const [state, setState] = useState<SharedRuntimeState>("starting");
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // The transport helper starts after the desktop mounts and returns its abort
  // cleanup. Retrying replaces the previous request/poll lifecycle exactly once.
  useEffect(() => startSharedWorkspaceRuntime(setState), [attempt]);
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
