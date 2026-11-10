import React, { useCallback, useState } from "react";
import { UsageSelect } from "@matrix-os/ui/ai-usage-select";
import { AutomaticAiUsagePanel } from "@matrix-os/ui/ai-usage-auto";
import { loadMatrixUsage } from "../../../lib/ai-usage-history";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
export default function AiUsageSection() {
  const [source, setSource] = useState<"local" | "matrix">("matrix");
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot),
    authGeneration = useConnection((s) => s.authGeneration),
    userId = useConnection((s) => s.userId);
  const scope = `${userId}:${runtimeSlot}:${authGeneration}:${source}`;
  const [delivery, setDelivery] = useState<{
    scope: string;
    backup: boolean;
    synced: boolean;
  } | null>(null);
  const load = useCallback(
    async (signal: AbortSignal, trigger: "open" | "manual" | "hourly") => {
      signal.throwIfAborted();
      if (source === "matrix") {
        if (!api) throw new Error("Usage unavailable");
        const sync = await invoke("runtime:ai-usage-sync", {
          runtimeSlot,
          authGeneration,
          force: trigger === "manual",
        });
        signal.throwIfAborted();
        const result = await loadMatrixUsage(
          api.forRuntime(runtimeSlot),
          userId,
          signal,
          { syncedExport: sync.status === "synced" },
        );
        signal.throwIfAborted();
        setDelivery({
          scope,
          backup: result.backup,
          synced: sync.status === "synced",
        });
        return result.snapshot;
      }
      const result = await invoke("runtime:ai-usage", {
        runtimeSlot,
        authGeneration,
      });
      signal.throwIfAborted();
      return result;
    },
    [runtimeSlot, authGeneration, source, api, userId, scope],
  );
  return (
    <div>
      <label className="ai-usage au-auto-status">
        Usage source{" "}
        <UsageSelect label="Usage source" value={source} onChange={value=>setSource(value as "local"|"matrix")} options={[{value:"local",label:"Recent local scan (partial)"},{value:"matrix",label:"Matrix + backed-up history"}]}/>
      </label>
      <AutomaticAiUsagePanel
        key={`${userId}:${runtimeSlot}:${authGeneration}:${source}`}
        load={load}
        loadingLabel={
          source === "matrix" ? "Syncing Mac usage to Matrix…" : undefined
        }
        sourceLabel={
          source === "local"
            ? "this Mac"
            : delivery?.scope === scope && delivery.synced
              ? "Mac + Matrix · synced"
              : delivery?.scope === scope
                ? "Matrix history · Mac sync not paired"
                : "your Matrix computer"
        }
      />
    </div>
  );
}
