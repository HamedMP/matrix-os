import React, { useCallback, useState } from "react";
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
  } | null>(null);
  const load = useCallback(
    async (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (source === "matrix") {
        if (!api) throw new Error("Usage unavailable");
        const result = await loadMatrixUsage(
          api.forRuntime(runtimeSlot),
          userId,
          signal,
        );
        signal.throwIfAborted();
        setDelivery({ scope, backup: result.backup });
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
        <select
          aria-label="Usage source"
          value={source}
          onChange={(e) => setSource(e.target.value as "local" | "matrix")}
        >
          <option value="local">Recent local scan (partial)</option>
          <option value="matrix">Matrix + backed-up history</option>
        </select>
      </label>
      <AutomaticAiUsagePanel
        key={`${userId}:${runtimeSlot}:${authGeneration}:${source}`}
        load={load}
        sourceLabel={
          source === "local"
            ? "this Mac"
            : delivery?.scope === scope && delivery.backup
              ? "Matrix backup snapshot"
              : "your Matrix computer"
        }
      />
    </div>
  );
}
