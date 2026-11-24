import { useEffect, useRef } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { SetupQuestion } from "./creation-conversation.js";
import { chatAgentButtonClass } from "./theme.js";

export function AgentSetupTranscript({ detail, questions, openingMessageId, question, onAnswer, disabled }: {
  detail: CanonicalChatDetailResponse | null; questions: SetupQuestion[]; openingMessageId?: string;
  question: SetupQuestion | null; onAnswer(value: string): void; disabled: boolean;
}) {
  const rows = (detail?.messages ?? []).flatMap(message => {
    if (message.chatId !== detail?.record.chat.id || message.id === openingMessageId || (message.role !== "user" && message.role !== "assistant")) return [];
    const body = message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("");
    return body.trim() ? [{ key: message.id, role: message.role, body, runId: message.runId, at: message.createdAt }] : [];
  });
  for (const item of questions) {
    if (!rows.some(row => row.role === "assistant" && row.runId === item.runId && row.body.includes(item.question))) {
      rows.push({ key: item.id, role: "assistant", body: item.question, runId: item.runId, at: item.occurredAt });
    }
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const end = useRef<HTMLDivElement>(null);
  const lastKey = rows.at(-1)?.key;
  useEffect(() => {
    if (lastKey) end.current?.scrollIntoView?.({ block: "nearest" });
  }, [lastKey, question?.id]);
  if (!rows.length) return null;
  return <div className="relative grid gap-3">
    <ol aria-label="Setup messages" aria-live="polite" className="grid gap-4 text-sm leading-relaxed">
      {rows.map(row => <li key={row.key} className={row.role === "user"
        ? "max-w-[85%] justify-self-end whitespace-pre-wrap break-words rounded-xl bg-[var(--bg-hover,var(--secondary))] px-3 py-2"
        : "min-w-0 whitespace-pre-wrap break-words"}>{row.body}</li>)}
    </ol>
    {question ? <div role="group" aria-label="Suggested replies" className="flex flex-wrap gap-2">
      {question.suggestedReplies.map(reply => <button key={reply} type="button"
        className={`${chatAgentButtonClass} max-w-full whitespace-normal break-words text-left`}
        disabled={disabled} onClick={() => onAnswer(reply)}>{reply}</button>)}
    </div> : null}
    <div ref={end} aria-hidden="true" className="pointer-events-none absolute bottom-0 h-0 scroll-mb-32" />
  </div>;
}
