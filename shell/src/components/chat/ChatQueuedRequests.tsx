import { SubmittedBotAnswers, isBotAnswerContinuation } from "@matrix-os/ui";
import { useState } from "react";
import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";

export function ChatQueuedRequests({ turns, onCancel }: {
  turns: CanonicalChatQueuedTurn[]; onCancel?: (id: string) => Promise<boolean>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!turns.length) return null;
  const answers = turns.filter(isBotAnswerContinuation);
  const queued = turns.filter(turn => !isBotAnswerContinuation(turn));
  if (!queued.length) return <SubmittedBotAnswers turns={answers} onCancel={onCancel} disabled={pending !== null} />;
  return <><SubmittedBotAnswers turns={answers} onCancel={onCancel} disabled={pending !== null} /><div className="mx-auto w-full max-w-[720px] px-3 py-2 text-xs" aria-label="Queued requests">
    <p className="mb-2 font-medium">Queued next</p>
    {queued.map((turn) => <div key={turn.id} className="flex items-center gap-3 rounded-lg border p-2">
      <p className="min-w-0 flex-1 truncate">{turn.parts.map((part) => part.type === "text" ? part.text : part.type === "resource_reference" ? `@${part.resource.label}` : "Attachment").join(" ")}</p>
      <button type="button" className="rounded-md px-2 py-1 hover:bg-accent disabled:opacity-50" disabled={!onCancel || pending !== null} onClick={async () => {
        setPending(turn.id); setError(null);
        // react-doctor-disable-next-line react-hooks-js/todo -- Keep the queue action guard released in finally on both network and application failures.
        try { if (!await onCancel?.(turn.id)) setError("Queued request could not be cancelled. Try again."); }
        catch (failure: unknown) {
          console.warn("[chat] Queue cancellation failed:", failure instanceof Error ? failure.name : "UnknownError");
          setError("Queued request could not be cancelled. Try again.");
        } finally { setPending(null); }
      }}>Cancel queued request</button>
    </div>)}
    {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
  </div></>;
}
