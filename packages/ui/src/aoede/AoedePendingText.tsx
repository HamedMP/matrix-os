"use client";
import type { PendingAoedeText } from "./text-turn.js";
import { boundedAoedeText } from "./presentation.js";
/** Unknown admission stays with the controller; retry uses the original request identity. */
export function AoedePendingText({ pending, retry }: { pending?: PendingAoedeText | null; retry?: () => Promise<boolean> }) {
  if (!pending) return null;
  const retryMessage = async () => {
    try { await retry?.(); }
    catch (error: unknown) { console.warn("[aoede] message recovery unavailable", error instanceof Error ? error.name : "UnknownError"); }
  };
  return <div role="status" className="matrix-aoede-live__pending">
    <p>{pending.status === "sending" ? "Sending message…" : "Message not confirmed."}</p>
    <p>{boundedAoedeText(pending.text, 8000)}</p>
    <button type="button" disabled={pending.status === "sending" || !retry} onClick={() => void retryMessage()}>Retry message</button>
  </div>;
}
