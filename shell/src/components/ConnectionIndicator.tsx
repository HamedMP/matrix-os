"use client";

import { useConnectionHealth } from "@/hooks/useConnectionHealth";
import { manualReconnect } from "@/hooks/useSocket";

export function connectionIndicatorCopy(state: "connected" | "reconnecting" | "disconnected"): string | null {
  if (state === "connected") return null;
  if (state === "reconnecting") return "Cloud runtime reconnecting...";
  return "Cloud runtime disconnected";
}

export function ConnectionIndicator() {
  const state = useConnectionHealth((s) => s.state);
  const copy = connectionIndicatorCopy(state);

  if (state === "connected") return null;

  if (state === "reconnecting") {
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-1 text-xs text-yellow-500"
        title="Reconnecting to server..."
      >
        <span className="size-2 rounded-full bg-yellow-500 animate-pulse" />
        {copy}
      </div>
    );
  }

  return (
    <button
      className="flex items-center gap-1.5 px-2 py-1 text-xs text-red-500 hover:text-red-400 transition-colors"
      onClick={manualReconnect}
      title="Connection lost. Click to reconnect."
    >
      <span className="size-2 rounded-full bg-red-500" />
      {copy}
    </button>
  );
}
