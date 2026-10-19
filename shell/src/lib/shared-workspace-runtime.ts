import { SHARED_WORKSPACE_PREFIX, parseSharedRuntimeState, type SharedRuntimeState } from "./shared-workspace";

/** Plain transport lifecycle; React owns only the published snapshot and cleanup. */
export function startSharedWorkspaceRuntime(onState: (state: SharedRuntimeState) => void, fetcher: typeof fetch = fetch): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (state: SharedRuntimeState) => { if (!controller.signal.aborted) onState(state); };
  const request = (path: string, init: RequestInit = {}) => fetcher(`${SHARED_WORKSPACE_PREFIX}${path}`, {
    ...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  async function refresh() {
    try {
      const response = await request("/api/workspace/runtime");
      if (!response.ok) { publish(response.status === 403 ? "disabled" : "failed"); return; }
      const payload = await response.json();
      publish(parseSharedRuntimeState(payload.state));
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn("[workspace] Runtime status unavailable", error instanceof Error ? error.name : "UnknownError");
        publish("failed");
      }
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 3000);
    }
  }
  async function wake() {
    try {
      const response = await request("/api/workspace/actions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "wake" }),
      });
      if (!response.ok && response.status === 403) publish("disabled");
      // Acceptance and network errors cannot establish actual readiness. The
      // independent status loop also recovers an ambiguously accepted wake.
    } catch (error: unknown) {
      if (!controller.signal.aborted) console.warn("[workspace] Compute start unavailable", error instanceof Error ? error.name : "UnknownError");
    }
  }
  // One loop, started independently of the wake response after React mounts.
  void refresh();
  void wake();
  return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
}
