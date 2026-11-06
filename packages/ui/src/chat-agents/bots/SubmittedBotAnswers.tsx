import { useState } from "react";
import { BotInteractionIdSchema, type CanonicalChatQueuedTurn } from "@matrix-os/contracts";

/** Presentation only: the server owns interaction validation and continuation admission. */
export function isBotAnswerContinuation(turn: CanonicalChatQueuedTurn): boolean {
  const prefix = "req_answer_";
  return turn.clientRequestId.startsWith(prefix)
    && BotInteractionIdSchema.safeParse(turn.clientRequestId.slice(prefix.length)).success;
}

/** Answers are already submitted. A finishing worker hands them to its next turn automatically. */
export function SubmittedBotAnswers({ turns, onCancel, disabled = false }: {
  turns: readonly CanonicalChatQueuedTurn[];
  onCancel?: (id: string) => void | Promise<boolean | void>;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  async function cancel(id: string) {
    if (!onCancel || disabled || pending !== null) return;
    setPending(id); setError(false);
    try { if (await onCancel(id) === false) setError(true); }
    catch (failure: unknown) {
      console.warn("[chat] Pending answer cancellation failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally { setPending(null); }
  }
  if (!turns.length) return null;
  return <section aria-label="Submitted answers" className="mx-auto grid w-full max-w-[720px] gap-2 px-3 py-2">
    {turns.map(turn => <div key={turn.id} className="ml-auto max-w-full rounded-2xl border px-4 py-3">
      <p className="whitespace-pre-wrap break-words text-sm">{turn.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")}</p>
      <p role="status" className="mt-2 text-xs opacity-70">Answer sent. Continuing automatically after the current step.</p>
      {onCancel ? <button type="button" aria-label="Cancel pending answer" disabled={disabled || pending !== null}
        className="mt-2 rounded-md px-2 py-1 text-xs disabled:opacity-50" onClick={() => { void cancel(turn.id); }}>Cancel answer</button> : null}
    </div>)}
    {error ? <p role="alert" className="text-xs">The pending answer could not be cancelled. Try again.</p> : null}
  </section>;
}
