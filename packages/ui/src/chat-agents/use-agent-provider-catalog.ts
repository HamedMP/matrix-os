import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { ChatAgentClient } from "./client.js";

type DiscoveryScope = { active: boolean; generation: number; forced: boolean; queuedForce: boolean; pending?: Promise<void> };
/** Event-driven, owner/client-scoped discovery. Refresh never changes an editor draft. */
export function useAgentProviderCatalog(client: ChatAgentClient) {
  const scope = useMemo<DiscoveryScope>(() => ({ active: false, generation: 0, forced: false, queuedForce: false }), [client]);
  const [result, setResult] = useState<{ scope: DiscoveryScope; catalog: CanonicalProviderCatalog | null; loading: boolean; error: string } | null>(null);
  const load = useCallback(function discover(force: boolean): Promise<void> {
    if (!scope.active) return Promise.resolve();
    if (scope.pending) {
      if (force && !scope.forced) scope.queuedForce = true;
      return scope.pending;
    }
    const generation = scope.generation;
    const current = () => scope.active && generation === scope.generation;
    scope.forced = force;
    setResult(previous => ({ scope, catalog: previous?.scope === scope ? previous.catalog : null, loading: true, error: "" }));
    const pending = client.catalog({ refresh: force }).then(catalog => {
      if (current()) setResult({ scope, catalog, loading: scope.queuedForce, error: "" });
    }).catch((error: unknown) => {
      console.warn("[chat-agents] Model catalog unavailable:", error instanceof Error ? error.name : "UnknownError");
      // Never allow an old ready catalog to authorize a changed selection after a failed refresh.
      if (current()) setResult({ scope, catalog: null, loading: scope.queuedForce, error: "Models could not be refreshed. Your draft is still here." });
    }).finally(() => {
      if (scope.pending !== pending) return;
      scope.pending = undefined;
      if (current() && scope.queuedForce) { scope.queuedForce = false; void discover(true); }
    });
    scope.pending = pending;
    return pending;
  }, [client, scope]);
  useEffect(() => {
    scope.active = true;
    void load(false);
    return () => { scope.active = false; scope.generation += 1; scope.pending = undefined; scope.queuedForce = false; };
  }, [scope, load]);
  const current = result?.scope === scope ? result : null;
  const refresh = useCallback(() => { void load(true); }, [load]);
  return { catalog: current?.catalog ?? null, loading: current?.loading ?? true, error: current?.error ?? "", refresh };
}
