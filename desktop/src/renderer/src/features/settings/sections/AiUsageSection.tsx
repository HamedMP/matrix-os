import React, { useCallback, useState } from "react";
import { UsageSelect } from "@matrix-os/ui/ai-usage-select";
import { AutomaticAiUsagePanel } from "@matrix-os/ui/ai-usage-auto";
import { loadDesktopUsage } from "../../../lib/ai-usage-history";
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
    sync: "synced" | "unpaired" | "failed";
  } | null>(null);
  const load = useCallback(
    async (signal: AbortSignal, trigger: "open" | "manual" | "hourly") => {
      signal.throwIfAborted();
      if (source === "matrix") {
        if (!api) throw new Error("Usage unavailable");
        const result = await loadDesktopUsage({
          sync: () =>
            invoke("runtime:ai-usage-sync", {
              runtimeSlot,
              authGeneration,
              force: trigger === "manual",
            }),
          api: api.forRuntime(runtimeSlot),
          owner: userId,
          signal,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        signal.throwIfAborted();
        setDelivery({ scope, backup: result.backup, sync: result.sync });
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
            : delivery?.scope !== scope
              ? "your Matrix computer"
              : delivery.sync === "synced"
                ? "Mac + Matrix · synced"
                : delivery.sync === "failed"
                  ? "Matrix history · Mac sync failed, will retry"
                  : "Matrix history · Mac sync not paired"
        }
      />
    </div>
  );
}
