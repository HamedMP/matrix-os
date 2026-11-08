import { isRoutineDirectChatId, type RoutineChatReceiptPart } from "@matrix-os/contracts";
import { ScheduledMessageMeta } from "./ScheduledMessageMeta.js";
import { routineReceiptOutcome } from "./routine-receipt.js";

export function RoutineReceipt({ receipt, text, onOpenChat, sourceChatId }: {
  receipt: RoutineChatReceiptPart; text: string; sourceChatId?: string; onOpenChat?: (chatId: string) => void;
}) {
  const internalExecutor = isRoutineDirectChatId(receipt.canonicalChatId);
  return <section aria-label="Scheduled task result" data-routine-receipt={receipt.fireId} className="grid min-w-0 gap-2 rounded-xl border p-3 text-sm">
    <ScheduledMessageMeta timestamp={receipt.scheduledFor} sent={false}/>
    <p>{routineReceiptOutcome(receipt)}</p>
    {text ? <p className="whitespace-pre-wrap break-words">{text}</p> : <p>Output unavailable. Review this task in Schedules.</p>}
    <details className="text-xs"><summary>Execution details</summary><dl>
      <dt>Scheduler</dt><dd>Matrix routine</dd>
      <dt>Routine</dt><dd>{receipt.routineId}</dd>
      <dt>Occurrence</dt><dd>{receipt.fireId} · attempt {receipt.attempt}</dd>
      {sourceChatId ? <><dt>Source Chat</dt><dd>{sourceChatId}</dd></> : null}
      <dt>Model</dt><dd>{receipt.model}</dd>
      {!internalExecutor ? <><dt>Executor Chat</dt><dd>{receipt.canonicalChatId}</dd></> : null}
      <dt>Task</dt><dd>{receipt.canonicalTaskId}</dd>
    </dl></details>
    {onOpenChat && !internalExecutor ? <button type="button" className="justify-self-start underline" onClick={() => onOpenChat(receipt.canonicalChatId)}>Open execution history</button> : null}
  </section>;
}
