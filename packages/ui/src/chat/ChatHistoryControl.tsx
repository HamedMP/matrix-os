import React from "react";
import type { CanonicalChatHistoryControls } from "./use-canonical-chat-history.js";
export function ChatHistoryControl({ history }: { history?: CanonicalChatHistoryControls }) {
  if (!history?.hasEarlier && !history?.error) return null;
  return <div className="flex flex-col items-center gap-2 p-3 text-sm">
    {history.hasEarlier ? <button type="button" disabled={history.loading} className="rounded-lg border px-3 py-2 disabled:opacity-50" onClick={() => void history.loadEarlier()}>
      {history.loading ? "Loading earlier messages…" : "Load earlier messages"}
    </button> : null}
    {history.error ? <p role="alert">{history.error}</p> : null}
  </div>;
}
