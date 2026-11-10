"use client";
import React, { useCallback } from "react";
import { AutomaticAiUsagePanel } from "@matrix-os/ui/ai-usage-auto";
import { readUsageExport } from "@matrix-os/contracts/ai-usage";
import { getGatewayUrl } from "@/lib/gateway";
export function AiUsageSection() {
  const base = getGatewayUrl();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(`${base}/api/ai-usage`, {
        credentials: "include",
        signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
      });
      if (!response.ok) throw new Error("Usage unavailable");
      return readUsageExport(await response.json());
    },
    [base],
  );
  return (
    <AutomaticAiUsagePanel
      key={base}
      load={load}
      sourceLabel="your Matrix computer"
    />
  );
}
